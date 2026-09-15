"use node";

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { extractText } from "../cvs/cvExtraction";
import { executeLLMWithNvidiaFallback, getNvidiaOpenAI, logLLMUsage } from "../lib/llm";
import { resolveCandidateLocation } from "../lib/locationResolver";

const PROMPT_VERSION = "v1.0";
const EXPANSION_MODEL = "meta/llama-3.1-70b-instruct";

export const evaluateCvForCriteria = action({
  args: {
    resultId: v.id("cvScanResults"),
    scanId: v.id("cvScans"),
  },
  handler: async (ctx, args) => {
    // 1. Fetch scan and result details
    const scan = await ctx.runQuery(api.cvScanner.scanMutations.getScanSession, { scanId: args.scanId });
    const results = await ctx.runQuery(api.cvScanner.scanMutations.getScanResults, { scanId: args.scanId });
    const result = results?.find((r: any) => r._id === args.resultId);

    if (!scan || !result) {
      console.error(`[evaluateCvForCriteria] Scan ${args.scanId} or Result ${args.resultId} not found.`);
      return;
    }

    const currentAttempts = (result.extractionAttempts || 0) + 1;

    // Mark as processing
    await ctx.runMutation(internal.cvScanner.scanMutations.updateResult, {
      resultId: args.resultId,
      status: "processing",
      extractionAttempts: currentAttempts,
    });

    try {
      // 2. Fetch raw file buffer from R2 or Convex storage
      let buffer: ArrayBuffer;
      if (result.s3Key) {
        const downloadUrl = await ctx.runAction(api.storage.r2.generateDownloadUrl, { key: result.s3Key });
        const res = await fetch(downloadUrl);
        if (!res.ok) {
          throw new Error(`Failed to fetch file from R2 storage (HTTP ${res.status})`);
        }
        buffer = await res.arrayBuffer();
      } else if (result.fileStorageId) {
        const blob = await ctx.storage.get(result.fileStorageId);
        if (!blob) {
          throw new Error("File blob could not be retrieved from Convex storage");
        }
        buffer = await blob.arrayBuffer();
      } else {
        throw new Error("Missing storage reference (neither R2 s3Key nor Convex fileStorageId present)");
      }

      // 3. REUSE approved extraction pipeline from cvExtraction.ts
      const { text: rawText } = await extractText(buffer, result.fileType, false, ctx);

      if (!rawText || rawText.trim().length < 20) {
        throw new Error("Unable to extract readable text from document.");
      }

      // 4. Formulate evaluation for Keyword criteria (via DeepSeek) and Location criteria (via Location Resolver)
      const expandedCriteria = scan.expandedCriteria || [];
      const locationCriteria = expandedCriteria.filter((ec: any) => ec.isLocation);
      const keywordCriteria = expandedCriteria.filter((ec: any) => !ec.isLocation);

      let parsed: any = {};
      const criterionScores: Array<{ criterion: string; score: number }> = [];
      const evidenceQuotesList: Array<{ quote: string; isVerifiedQuote: boolean }> = [];

      // 4a. Evaluate untagged keyword criteria via DeepSeek if any exist
      if (keywordCriteria.length > 0 || expandedCriteria.length === 0) {
        const expandedContext = keywordCriteria.length > 0
          ? keywordCriteria
              .map(
                (ec: any, i: number) =>
                  `CRITERION ${i + 1}: "${ec.original}"
  - Semantic Meaning: ${ec.definition}
  - Equivalent Job Titles / Role Variations: ${ec.equivalentTitles.join(", ")}
  - Related Skills & Signals: ${ec.relatedSignals.join(", ")}`
              )
              .join("\n\n")
          : scan.criteria
              .map((c: any, i: number) => `${i + 1}. ${typeof c === "object" ? c.text : c}`)
              .join("\n");

        const systemPrompt = `You are an expert HR recruiter and candidate screening assistant.
Evaluate the candidate's CV text against the requested criteria list and their expanded semantic meanings.

CRITICAL INSTRUCTIONS:
1. Candidate Identity: Extract candidate name, email, phone, current title if present in text.
2. Criterion Scoring: Assign a match score from 0 to 100 for EACH criterion. A candidate matches if their actual experience aligns with the criteria's substance.
3. Order of JSON Fields: Return "reasoning" FIRST, then "criterionScores", then "evidenceQuotes".
4. Evidence Quotes: Provide 1 to 3 exact, verbatim sentences or phrases copied from the CV text that support your evaluation.
5. Reasoning: Write a 1-2 sentence executive summary of the evaluation.

Respond ONLY with valid JSON matching this schema:
{
  "candidateName": "John Doe",
  "email": "john@example.com",
  "phone": "+94...",
  "currentTitle": "BD Manager",
  "reasoning": "Executive summary...",
  "criterionScores": [
    { "criterion": "Worked in BD previously", "score": 90 }
  ],
  "evidenceQuotes": [
    "Exact verbatim quote from CV text..."
  ]
}`;

        const userPrompt = `TARGET CRITERIA & EXPANDED SEMANTIC CONTEXT:
${expandedContext}

CANDIDATE CV TEXT:
${rawText.slice(0, 15000)}`;

        const { content } = await executeLLMWithNvidiaFallback(ctx, "cv_criteria_match", {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        });

        try {
          parsed = JSON.parse(content);
        } catch (err) {
          console.warn("[evaluateCvForCriteria] Failed to parse JSON from LLM response:", content);
        }

        if (Array.isArray(parsed.criterionScores)) {
          for (const cs of parsed.criterionScores) {
            criterionScores.push({
              criterion: String(cs.criterion || "Criterion"),
              score: Math.min(100, Math.max(0, Number(cs.score) || 0)),
            });
          }
        }
      }

      // 4b. Evaluate location-tagged criteria via Location Resolver
      if (locationCriteria.length > 0) {
        let candidateResolvedLocation = null;
        try {
          candidateResolvedLocation = await resolveCandidateLocation(ctx, rawText.slice(0, 3000));
        } catch (locErr) {
          console.warn("[evaluateCvForCriteria] Location resolution error:", locErr);
        }

        const candidateCountry = (candidateResolvedLocation?.country || "").toLowerCase();
        const candidateRegion = (candidateResolvedLocation?.region || "").toLowerCase();
        const candidateCity = (candidateResolvedLocation?.city || "").toLowerCase();
        const rawLocText = (candidateResolvedLocation?.raw_text || rawText).toLowerCase();

        for (const locCrit of locationCriteria) {
          const targetTerm = (locCrit.original || "").toLowerCase().trim();
          let score = 0;
          let matchDetail = "";

          if (
            (candidateCountry && (candidateCountry.includes(targetTerm) || targetTerm.includes(candidateCountry))) ||
            (candidateRegion && (candidateRegion.includes(targetTerm) || targetTerm.includes(candidateRegion))) ||
            (candidateCity && (candidateCity.includes(targetTerm) || targetTerm.includes(candidateCity))) ||
            rawLocText.includes(targetTerm)
          ) {
            score = 100;
            matchDetail = `Candidate location "${candidateResolvedLocation?.city ? candidateResolvedLocation.city + ', ' : ''}${candidateResolvedLocation?.country || 'Resolved Location'}" matches requested location "${locCrit.original}"`;
          } else {
            score = 0;
            matchDetail = `Candidate location "${candidateResolvedLocation?.city ? candidateResolvedLocation.city + ', ' : ''}${candidateResolvedLocation?.country || 'Unmatched'}" does not match requested location "${locCrit.original}"`;
          }

          criterionScores.push({
            criterion: `Location: ${locCrit.original}`,
            score,
          });

          if (score === 100) {
            evidenceQuotesList.push({
              quote: matchDetail,
              isVerifiedQuote: true,
            });
          }
        }
      }

      // Fallback regex candidate identity extraction if no keyword LLM call was run
      const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const phoneMatch = rawText.match(/\+?\d[\d\s-]{7,}\d/);

      const candidateName = parsed.candidateName || result.fileName.replace(/\.[^/.]+$/, "");
      const email = parsed.email || (emailMatch ? emailMatch[0] : undefined);
      const phone = parsed.phone || (phoneMatch ? phoneMatch[0] : undefined);
      const currentTitle = parsed.currentTitle || undefined;
      const reasoning = parsed.reasoning || (locationCriteria.length > 0 ? "Location and criteria evaluation completed." : "Evaluation completed.");

      // 5. Multi-criteria Soft Scoring Math across ALL criteria
      const totalScoreSum = criterionScores.reduce((acc, curr) => acc + curr.score, 0);
      const matchScore = criterionScores.length > 0 ? Math.round(totalScoreSum / criterionScores.length) : 0;

      const matchedCriteria = criterionScores
        .filter((cs) => cs.score >= 60)
        .map((cs) => cs.criterion);

      const isMatch = matchScore >= 60;

      // 6. Substring Hallucination Check for Evidence Quotes
      const rawTextNormalized = rawText.toLowerCase().replace(/\s+/g, " ");
      const rawEvidence: string[] = Array.isArray(parsed.evidenceQuotes) ? parsed.evidenceQuotes.map(String) : [];

      const verifiedEvidenceQuotes = [
        ...evidenceQuotesList,
        ...rawEvidence.map((quote) => {
          const quoteNormalized = quote.toLowerCase().replace(/\s+/g, " ").trim();
          const isVerified = quoteNormalized.length > 10 && rawTextNormalized.includes(quoteNormalized.slice(0, Math.min(40, quoteNormalized.length)));
          return {
            quote,
            isVerifiedQuote: isVerified,
          };
        }),
      ];

      // 7. Update scan result as completed
      await ctx.runMutation(internal.cvScanner.scanMutations.updateResult, {
        resultId: args.resultId,
        status: "completed",
        candidateName,
        email,
        phone,
        currentTitle,
        matchScore,
        isMatch,
        matchedCriteria,
        criterionScores,
        evidenceQuotes: verifiedEvidenceQuotes,
        reasoning,
      });

    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.error(`[evaluateCvForCriteria] Error evaluating result ${args.resultId} (Attempt ${currentAttempts}):`, errorMsg);

      // Single-retry soft-terminal pattern
      if (currentAttempts < 2) {
        console.log(`[evaluateCvForCriteria] Scheduling retry 2 for result ${args.resultId}...`);
        await ctx.scheduler.runAfter(2000, api.cvScanner.scanActions.evaluateCvForCriteria, {
          resultId: args.resultId,
          scanId: args.scanId,
        });
      } else {
        await ctx.runMutation(internal.cvScanner.scanMutations.updateResult, {
          resultId: args.resultId,
          status: "failed",
          error: errorMsg,
        });
      }
    }
  },
});

export const triggerScanBatch = action({
  args: {
    scanId: v.id("cvScans"),
  },
  handler: async (ctx, args) => {
    const results = await ctx.runQuery(api.cvScanner.scanMutations.getScanResults, { scanId: args.scanId });
    if (!results || results.length === 0) return;

    await ctx.runMutation(api.cvScanner.scanMutations.updateScanStatus, {
      scanId: args.scanId,
      status: "processing",
    });

    // Reuse 8-worker concurrency pool (stagger dispatch by 300ms to stay within VPS rate-limit window)
    let index = 0;
    for (const res of results) {
      const delayMs = index * 300;
      await ctx.scheduler.runAfter(delayMs, api.cvScanner.scanActions.evaluateCvForCriteria, {
        resultId: res._id,
        scanId: args.scanId,
      });
      index++;
    }
  },
});

export const getScanResultDownloadUrl = action({
  args: {
    resultId: v.id("cvScanResults"),
  },
  handler: async (ctx, args): Promise<{ url: string | null; fileName: string; candidateName?: string }> => {
    const result: any = await ctx.runQuery(api.cvScanner.scanMutations.getScanResultById, { resultId: args.resultId });
    if (!result) return { url: null, fileName: "Document.pdf" };

    let url: string | null = null;
    const ext = (result.fileType || result.fileName || "").toLowerCase();
    const isWordDoc = ext.includes("doc");

    if (result.s3Key) {
      // Omit downloadFilename for PDFs & Images so R2 serves inline disposition without auto-downloading!
      url = await ctx.runAction(api.storage.r2.generateDownloadUrl, {
        key: result.s3Key,
        downloadFilename: isWordDoc ? result.fileName : undefined,
      });
    } else if (result.fileStorageId) {
      url = await ctx.storage.getUrl(result.fileStorageId);
    }

    return {
      url,
      fileName: result.fileName,
      candidateName: result.candidateName,
    };
  },
});

export const expandCriteriaViaNim = action({
  args: {
    scanId: v.id("cvScans"),
  },
  handler: async (ctx, args) => {
    const scan = await ctx.runQuery(api.cvScanner.scanMutations.getScanSession, { scanId: args.scanId });
    if (!scan) {
      throw new Error(`Scan session ${args.scanId} not found`);
    }

    if (!scan.criteria || scan.criteria.length === 0) {
      await ctx.runMutation(internal.cvScanner.scanMutations.updateScanExpandedCriteria, {
        scanId: args.scanId,
        expandedCriteria: [],
      });
      return;
    }

    const expandedResults: Array<{
      original: string;
      definition: string;
      equivalentTitles: string[];
      relatedSignals: string[];
      isLocation?: boolean;
    }> = [];

    const nvidiaOpenAI = getNvidiaOpenAI();

    try {
      for (const rawCrit of scan.criteria) {
        const termText = typeof rawCrit === "object" && rawCrit !== null ? (rawCrit as any).text : String(rawCrit);
        const isLocation = typeof rawCrit === "object" && rawCrit !== null ? !!(rawCrit as any).isLocation : false;

        if (isLocation) {
          console.log(`[expandCriteriaViaNim] Bypassing NIM expansion for Location-tagged term "${termText}"`);
          expandedResults.push({
            original: termText,
            definition: "Location search filter",
            equivalentTitles: [],
            relatedSignals: [],
            isLocation: true,
          });
          continue;
        }

        const normalized = termText.trim().toLowerCase();

        // 1. Check cache first
        const cached: any = await ctx.runMutation(internal.cvScanner.scanMutations.getCachedExpansion, {
          normalizedCriterion: normalized,
          promptVersion: PROMPT_VERSION,
        });

        if (cached) {
          console.log(`[expandCriteriaViaNim] Cache HIT for criterion "${termText}"`);
          expandedResults.push({
            original: termText,
            definition: cached.definition,
            equivalentTitles: cached.equivalentTitles || [],
            relatedSignals: cached.relatedSignals || [],
            isLocation: false,
          });
          continue;
        }

        console.log(`[expandCriteriaViaNim] Cache MISS for criterion "${termText}". Invoking NVIDIA NIM (${EXPANSION_MODEL})...`);

        // 2. Invoke NVIDIA NIM Llama 3.1 70B Instruct for expansion
        const prompt = `You are an expert HR recruitment taxonomist.
Expand the following candidate search criterion into a rich, comprehensive semantic definition, equivalent job titles, and related experience signals.

Target Criterion: "${termText}"

CRITICAL INSTRUCTIONS:
1. Return ONLY a valid JSON object matching the exact schema below.
2. Do NOT wrap output in markdown \`\`\`json code blocks. Do NOT include preambles or explanations.

Expected JSON format:
{
  "definition": "A clear, 1-2 sentence description of what experience, responsibilities, or background this criterion represents",
  "equivalentTitles": ["List 5-8 common equivalent job titles or role variations that satisfy this criterion"],
  "relatedSignals": ["List 4-6 key skills, tools, duties, or achievements that signal this criterion"]
}`;

        const response = await nvidiaOpenAI.chat.completions.create({
          model: EXPANSION_MODEL,
          messages: [
            { role: "system", content: "You are a precise HR data taxonomist. Output strictly valid JSON." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 1024,
          response_format: { type: "json_object" },
        });

        if (response.usage) {
          await logLLMUsage(
            ctx,
            "criteria_expansion",
            EXPANSION_MODEL,
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
            true,
            undefined,
            undefined,
            "nvidia"
          );
        }

        const rawContent = response.choices[0]?.message?.content?.trim() || "";
        const cleanContent = rawContent.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

        const parsed = JSON.parse(cleanContent);
        const expansion = {
          definition: parsed.definition || termText,
          equivalentTitles: Array.isArray(parsed.equivalentTitles) ? parsed.equivalentTitles : [],
          relatedSignals: Array.isArray(parsed.relatedSignals) ? parsed.relatedSignals : [],
        };

        // 3. Cache the expansion result
        await ctx.runMutation(internal.cvScanner.scanMutations.saveCachedExpansion, {
          normalizedCriterion: normalized,
          expansion,
          promptVersion: PROMPT_VERSION,
        });

        expandedResults.push({
          original: termText,
          ...expansion,
          isLocation: false,
        });
      }

      // 4. Update cvScans record with expanded criteria
      await ctx.runMutation(internal.cvScanner.scanMutations.updateScanExpandedCriteria, {
        scanId: args.scanId,
        expandedCriteria: expandedResults,
      });

      console.log(`[expandCriteriaViaNim] Successfully expanded ${expandedResults.length} criteria for scan ${args.scanId}`);
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.error(`[expandCriteriaViaNim] Expansion failed for scan ${args.scanId}: ${errorMsg}`);

      await logLLMUsage(
        ctx,
        "criteria_expansion",
        EXPANSION_MODEL,
        0,
        0,
        false,
        `Criteria Expansion Failed: ${errorMsg}`,
        undefined,
        "nvidia"
      );

      await ctx.runMutation(internal.cvScanner.scanMutations.updateScanExpansionStatus, {
        scanId: args.scanId,
        expansionStatus: "failed",
      });

      throw new Error(`Criteria expansion failed: ${errorMsg}`);
    }
  },
});
