// @ts-nocheck
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel.d.ts";
import { mapJobSeniorityTo10LevelRank, checkSeniorityConflict, scoreCandidateAgainstRequirements, getSkillDomain } from "../cvs/cvScoring";
import { classifyJobRoleFamily, classifyCurrentRolesBatch } from "../lib/currentRoleClassifier";
import { synthesizeJobRequirements } from "../lib/jobSynthesizer";
import { upsertCandidateVector, queryCandidateVectors } from "../lib/qdrant";

/**
 * Helper to get vector embeddings from NVIDIA API
 */
export async function embedText(
  text: string,
  _inputType: "query" | "passage" = "query"
): Promise<{ embedding: number[]; usage: { promptTokens: number; model: string } }> {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const openRouterApiKey = process.env.OPENROUTER_API_KEYS?.split(",")[0]?.trim() || process.env.OPENROUTER_API_KEY;
  const nvidiaApiKey = process.env.NVIDIA_API_KEY;

  if (!openAiApiKey && !openRouterApiKey && !nvidiaApiKey) {
    throw new Error("No API key configured for vector embeddings (OPENAI_API_KEY / OPENROUTER_API_KEY / NVIDIA_API_KEY).");
  }

  const sanitized = text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    throw new Error("Text is empty after sanitization");
  }

  // 1. #1 Primary: OpenRouter API for openai/text-embedding-3-small
  const openRouterKey = process.env.OPENROUTER_API_KEYS?.split(",")[0]?.trim() || process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    const candidateModels = [
      "openai/text-embedding-3-small",
      "baai/bge-m3",
    ];

    for (const model of candidateModels) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openRouterKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://career141.com",
            "X-Title": "Career141 System",
          },
          body: JSON.stringify({
            input: sanitized,
            model,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.data && data.data[0] && data.data[0].embedding) {
            const rawEmbedding = data.data[0].embedding;
            const embedding = rawEmbedding.length > 1024 ? rawEmbedding.slice(0, 1024) : rawEmbedding;
            const promptTokens = data.usage?.prompt_tokens ?? 0;
            return {
              embedding,
              usage: { promptTokens, model },
            };
          }
        } else {
          const errText = await response.text();
          console.warn(`[embedText] OpenRouter ${model} error (${response.status}):`, errText);
        }
      } catch (fetchErr: any) {
        console.warn(`[embedText] OpenRouter ${model} network error:`, fetchErr?.message || fetchErr);
      }
    }
  }

  // 2. Fallback: NVIDIA NIM nemotron-3-embed-1b
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (nvidiaKey) {
    const nvidiaModels = [
      "nvidia/nemotron-3-embed-1b",
      "baai/bge-m3",
      "snowflake/arctic-embed-l",
    ];
    for (const model of nvidiaModels) {
      try {
        const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${nvidiaKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            input: [sanitized],
            model,
            encoding_format: "float",
            truncate: "END",
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.data && data.data[0] && data.data[0].embedding) {
            const rawEmbedding = data.data[0].embedding;
            const embedding = rawEmbedding.length > 1024 ? rawEmbedding.slice(0, 1024) : rawEmbedding;
            const promptTokens = data.usage?.prompt_tokens ?? 0;
            return {
              embedding,
              usage: { promptTokens, model },
            };
          }
        } else {
          const errText = await response.text();
          console.warn(`[embedText] NVIDIA ${model} error (${response.status}):`, errText);
        }
      } catch (e: any) {
        console.warn(`[embedText] NVIDIA ${model} network error:`, e?.message || e);
      }
    }
  }

  throw new Error("Failed to generate embedding across all configured providers (OpenRouter & NVIDIA NIM)");
}

/**
 * Internal action to embed a candidate's full text and save it to the DB.
 */
export const generateAndStoreEmbedding = internalAction({
  args: { 
    candidateId: v.id("candidates"),
    rawText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const candidate = await ctx.runQuery(internal.matching.queries.getCandidate, { candidateId: args.candidateId });
    if (!candidate) return;

    let rawText = args.rawText;
    if (!rawText) {
      const resume = await ctx.runQuery(internal.matching.queries.getCandidateResume, { candidateId: args.candidateId });
      if (resume?.rawText) {
        rawText = resume.rawText;
      } else if (resume?.rawTextKey) {
        rawText = (await ctx.runAction(api.storage.r2.getResumeRawText, { rawTextKey: resume.rawTextKey })) ?? undefined;
      }
    }
    if (!rawText || !rawText.trim()) return;

    const textToEmbed = rawText.slice(0, 15000); 
    try {
      const { embedding } = await embedText(textToEmbed, "passage");

      // 1. Direct upsert to Qdrant Vector Engine (SSD MMAP)
      await upsertCandidateVector({
        candidateId: args.candidateId,
        vector: embedding,
        payload: {
          candidateId: args.candidateId,
          fullName: candidate.fullName || "Candidate",
          currentJobTitle: candidate.currentJobTitle,
          skills: candidate.skills || [],
          totalExperienceYears: candidate.totalExperienceYears,
          seniorityLevel: candidate.seniorityLevel,
          locationCity: candidate.locationCity,
          locationCountry: candidate.locationCountry,
          sourceChannel: candidate.firstSourceChannel || candidate.sourceChannel,
          overallStatus: candidate.overallStatus,
          updatedAt: Date.now(),
        },
      });

      // 2. Mark hasEmbedding: true in Convex (lightweight flag, 0 float arrays)
      await ctx.runMutation(internal.matching.queries.markCandidateHasEmbedding, {
        candidateId: args.candidateId,
      });
    } catch (err) {
      console.warn(`[Agent2] Embedding generation / Qdrant upsert error for candidate ${args.candidateId}:`, err);
      throw err;
    }
  },
});

export const generateJobEmbedding = action({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: args.jobId });
    if (!job) return;

    const jobRequirementsText = `
      Title: ${job.title}
      Description: ${job.jobDescription}
      Required Skills: ${(job.requiredSkills || []).join(", ")}
      Nice to have Skills: ${(job.niceToHaveSkills || []).join(", ")}
      Industry: ${job.clientIndustry || ""}
      Seniority: ${job.seniorityLevel || ""}
    `;

    try {
      const { embedding: jobEmbedding, usage } = await embedText(jobRequirementsText);
      await ctx.runMutation(internal.matching.queries.updateJobEmbedding, {
        jobId: args.jobId,
        embedding: jobEmbedding,
      });

      await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
        logs: [
          {
            taskType: "embedding",
            model: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: 0,
            success: true,
          }
        ]
      });
    } catch (err) {
      await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
        logs: [
          {
            taskType: "embedding",
            model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
            promptTokens: 0,
            completionTokens: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }
        ]
      });
      throw err;
    }
  }
});

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reverse Match using Vector Search and Keyword Matching
 */
export const runReverseMatch = action({
  args: {
    jobId: v.id("jobs"),
    customPreferences: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const tokenLogs: any[] = [];
    try {
      const job = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: args.jobId });
      if (!job) return;

      // If customPreferences is provided, save it on the job record
      if (args.customPreferences !== undefined) {
        await ctx.runMutation(internal.jobs.jobs.updateTaPreferencesInternal, {
          jobId: args.jobId,
          taPreferences: args.customPreferences,
        });
      }

      const activePreferences = args.customPreferences !== undefined
        ? args.customPreferences
        : job.taPreferences;

      // Parse custom TA preferences with LLM if present
      let parsedPreferences: {
        overrideSeniority?: string | null;
        overrideLocation?: string | null;
        strictLocation?: boolean;
        domainPreference?: string | null;
        companyTypePreference?: string | null;
        requiredCertifications?: string[];
        maxYearsExperience?: number | null;
        minYearsExperience?: number | null;
        requiredSkillsOverride?: string[];
        negativeKeywords?: string[];
      } = {};

      if (activePreferences && activePreferences.trim()) {
        try {
          const { getModelForTask, getOpenAI, logLLMUsage } = await import("../lib/llm.js");
          const model = getModelForTask("reverse_matching");
          const openai = getOpenAI("reverse_matching");

          const response = await openai.chat.completions.create({
            model,
            temperature: 0.1,
            max_tokens: 400,
            messages: [
              {
                role: "system",
                content: `You are a Senior TA Recruiter. Extract all candidate criteria overrides from recruiter feedback.
Return ONLY valid JSON matching this schema:
{
  "overrideSeniority": "intern" | "junior" | "mid" | "senior" | "lead" | "executive" | null,
  "overrideLocation": string | null,
  "strictLocation": boolean | null,
  "domainPreference": string | null,
  "companyTypePreference": string | null,
  "requiredCertifications": string[],
  "maxYearsExperience": number | null,
  "minYearsExperience": number | null,
  "requiredSkillsOverride": string[],
  "negativeKeywords": string[]
}`
              },
              {
                role: "user",
                content: activePreferences
              }
            ],
            response_format: { type: "json_object" }
          });

          const content = response.choices[0]?.message?.content ?? "{}";
          const promptTokens = response.usage?.prompt_tokens ?? 0;
          const completionTokens = response.usage?.completion_tokens ?? 0;

          tokenLogs.push({
            taskType: "reverse_matching",
            model,
            promptTokens,
            completionTokens,
            success: true,
            provider: "openrouter",
          });

          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object") {
            parsedPreferences = {
              overrideSeniority: typeof parsed.overrideSeniority === "string" ? parsed.overrideSeniority : null,
              overrideLocation: typeof parsed.overrideLocation === "string" ? parsed.overrideLocation : null,
              strictLocation: Boolean(parsed.strictLocation || (typeof parsed.overrideLocation === "string" && activePreferences.toLowerCase().match(/\b(only|within|must be|located in|strict)\b/))),
              domainPreference: typeof parsed.domainPreference === "string" ? parsed.domainPreference : null,
              companyTypePreference: typeof parsed.companyTypePreference === "string" ? parsed.companyTypePreference : null,
              requiredCertifications: Array.isArray(parsed.requiredCertifications) ? parsed.requiredCertifications : [],
              maxYearsExperience: typeof parsed.maxYearsExperience === "number" ? parsed.maxYearsExperience : null,
              minYearsExperience: typeof parsed.minYearsExperience === "number" ? parsed.minYearsExperience : null,
              requiredSkillsOverride: Array.isArray(parsed.requiredSkillsOverride) ? parsed.requiredSkillsOverride : [],
              negativeKeywords: Array.isArray(parsed.negativeKeywords) ? parsed.negativeKeywords : [],
            };
          }
        } catch (err) {
          console.error("Failed to parse TA custom preferences:", err);
        }
      }

      // Set status to running immediately
      await ctx.runMutation(internal.jobs.jobs.saveReverseMatchResults, {
        jobId: args.jobId,
        results: job.reverseMatchResults || [],
        status: "running",
      });

      // 1. Perform Holistic AI Requirement Synthesis on the Job
      const synthesized = await synthesizeJobRequirements({
        title: job.title,
        jobDescription: job.jobDescription,
        requiredSkills: job.requiredSkills,
        niceToHaveSkills: job.niceToHaveSkills,
        clientIndustry: job.clientIndustry,
        seniorityLevel: job.seniorityLevel,
        taPreferences: activePreferences,
      });

      // Force regenerating job embedding if customPreferences parameter was explicitly provided
      let jobEmbedding = (args.customPreferences !== undefined) ? null : job.embedding;

      // 2. Generate job embedding if missing or if customPreferences provided using holistic synthesized prompt
      if (!jobEmbedding || jobEmbedding.length === 0) {
        const jobRequirementsText = `
          Title: ${synthesized.primaryRoleTitle}
          Target Domain: ${synthesized.targetDomain}
          Holistic Summary: ${synthesized.synthesizedEmbeddingPrompt}
          Core Mandatory Domain Skills: ${(synthesized.coreDomainSkills || []).join(", ")}
          General Commercial Skills: ${(synthesized.generalCommercialSkills || []).join(", ")}
          Domain Gate Constraints: ${synthesized.domainGateRules}
          Description: ${job.jobDescription.slice(0, 1500)}
          ${activePreferences ? `TA Recruiter Custom Preferences: ${activePreferences}` : ""}
        `;

        try {
          const embedResult = await embedText(jobRequirementsText);
          jobEmbedding = embedResult.embedding;
          tokenLogs.push({
            taskType: "embedding",
            model: embedResult.usage.model,
            promptTokens: embedResult.usage.promptTokens,
            completionTokens: 0,
            success: true,
          });

          // Save the embedding to the job record
          await ctx.runMutation(internal.matching.queries.updateJobEmbedding, {
            jobId: args.jobId,
            embedding: jobEmbedding,
          });
        } catch (err) {
          tokenLogs.push({
            taskType: "embedding",
            model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
            promptTokens: 0,
            completionTokens: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }

      // 3. Perform Precision Domain Keyword Search (using clean domain skills, avoiding filler verbs)
      const terms: string[] = [];
      if (synthesized.primaryRoleTitle) terms.push(synthesized.primaryRoleTitle);
      for (const s of (synthesized.coreDomainSkills ?? []).slice(0, 5)) {
        if (s && s.length > 2) terms.push(s);
      }
      if (job.clientIndustry) terms.push(job.clientIndustry);
      if (synthesized.targetDomain && synthesized.targetDomain !== job.clientIndustry) {
        terms.push(synthesized.targetDomain);
      }
      if (activePreferences && activePreferences.trim()) {
        const prefTerms = activePreferences
          .split(/[\n,;]+/)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 2 && s.length < 50)
          .slice(0, 2);
        terms.push(...prefTerms);
      }

      const termsToSearch = terms.slice(0, 3);
      const batches = await Promise.all(
        termsToSearch.map((term) =>
          ctx.runQuery(api.matching.search.searchCandidates, {
            query: term,
            industry: job.clientIndustry ?? undefined,
            seniority: job.seniorityLevel ?? undefined,
            limit: 50,
          })
        )
      );

      const dedupedKeywordsMap = new Map<string, { candidateId: Id<"candidates">; score: number }>();
      for (const batch of batches) {
        for (const result of batch) {
          if (result && result.candidateId) {
            const cIdStr = result.candidateId.toString();
            if (!dedupedKeywordsMap.has(cIdStr)) {
              dedupedKeywordsMap.set(cIdStr, { candidateId: result.candidateId, score: result.score });
            }
          }
        }
      }

      // 3. Perform Vector Search across all candidates using Qdrant (top 1,000 vectors with Convex fail-open fallback)
      const vectorResultsMap = new Map<string, number>();
      try {
        // Pure Cosine vector search across candidate embeddings (soft weighted scoring applied downstream)
        const qdrantMatches = await queryCandidateVectors(jobEmbedding, {
          limit: 1000,
        });

        for (const m of qdrantMatches) {
          if (m.candidateId) {
            vectorResultsMap.set(m.candidateId, m.score);
          }
        }
      } catch (qdrantErr: any) {
        console.warn("[Agent2 reverseMatchJob] Qdrant search error, falling back to Convex vectorSearch:", qdrantErr?.message);
      }

      // Fallback to Convex native vectorSearch if Qdrant returned 0 or was unreachable
      if (vectorResultsMap.size === 0) {
        try {
          const results = await ctx.vectorSearch("candidateResumes", "vector_index_candidates", {
            vector: jobEmbedding,
            limit: 64,
          });

          if (results.length > 0) {
            const mappedResumes = await ctx.runQuery(internal.matching.queries.getCandidateIdsByResumeIds, {
              resumeIds: results.slice(0, 64).map((r) => r._id),
            });
            const resumeIdToCandidateId = new Map(mappedResumes.map((item) => [item.resumeId, item.candidateId]));
            for (const r of results) {
              const cId = resumeIdToCandidateId.get(r._id);
              if (cId) {
                vectorResultsMap.set(cId.toString(), r._score);
              }
            }
          }
        } catch (convErr: any) {
          console.warn("[Agent2 reverseMatchJob] Convex vectorSearch fallback notice:", convErr?.message);
        }
      }

      // 4. Deduplicate all candidate IDs in memory
      const allCandidateIdStrings = new Set<string>([
        ...Array.from(vectorResultsMap.keys()),
        ...Array.from(dedupedKeywordsMap.keys()),
      ]);

      // 5. Batch fetch full candidate documents in a single query
      const allCandidateIds = Array.from(allCandidateIdStrings) as Id<"candidates">[];
      let candidatesMap = new Map<string, any>();
      if (allCandidateIds.length > 0) {
        const candidates = await ctx.runQuery(internal.matching.queries.getCandidatesBatch, {
          candidateIds: allCandidateIds,
        });
        for (const c of candidates) {
          candidatesMap.set(c._id.toString(), c);
        }
      }

      // 6. Generate missing embeddings on the fly for keyword-matched candidates (up to 3)
      // Only check candidates not returned by vector search
      const keywordCandidateIdsMissingEmbeddings = Array.from(dedupedKeywordsMap.keys()).filter(id => !vectorResultsMap.has(id));
      const keywordResumes = await ctx.runQuery(internal.matching.queries.getCandidateResumesBatch, {
        candidateIds: keywordCandidateIdsMissingEmbeddings as Id<"candidates">[]
      });
      const keywordResumeMap = new Map(keywordResumes.map((r: any) => [r.candidateId, r]));

      const missingEmbeddings = Array.from(dedupedKeywordsMap.values()).filter(
        k => {
          const cIdStr = k.candidateId.toString();
          if (vectorResultsMap.has(cIdStr)) return false; // Already has embedding from vector search
          const resume: any = keywordResumeMap.get(k.candidateId);
          return !resume || !resume.embedding || resume.embedding.length === 0;
        }
      );

      if (missingEmbeddings.length > 0) {
        const limitToEmbed = missingEmbeddings.slice(0, 3);
        await Promise.allSettled(
          limitToEmbed.map(async (k) => {
            try {
              const resume: any = keywordResumeMap.get(k.candidateId);
              if (resume && resume.rawText) {
                const textToEmbed = resume.rawText.slice(0, 15000);
                const embedResult = await embedText(textToEmbed, "passage");
                const embedding = embedResult.embedding;
                await ctx.runMutation(internal.matching.queries.updateCandidateEmbedding, {
                  candidateId: k.candidateId,
                  embedding,
                });
                resume.embedding = embedding; // Update in-memory reference
              }
            } catch (err) {
              console.warn(`[ReverseMatch] Non-blocking embedding generation notice for candidate ${k.candidateId}:`, err);
            }
          })
        );
      }

      // 7. Merge, enrich, and calculate similarity scores
      // Get existing results
      const existingResults = job.reverseMatchResults || [];

      // Get applications for checking human actions/shortlists
      const applications = await ctx.runQuery(internal.matching.queries.getApplicationsByJobIdInternal, { jobId: args.jobId });
      const appliedCandidateIds = new Set(
        (applications || []).map((app) => app.candidateId.toString())
      );

      // Keep only previously matched candidates who exist in the applications table (bounded growth)
      const existingToKeep = existingResults.filter((r) => appliedCandidateIds.has(r.cvId));
      const existingToKeepIds = existingToKeep.map(r => r.cvId);

      // Include existing TA-acted candidates in the final set
      for (const cId of existingToKeepIds) {
        if (!candidatesMap.has(cId)) {
          const cand = await ctx.runQuery(internal.matching.queries.getCandidate, { candidateId: cId as Id<"candidates"> });
          if (cand) candidatesMap.set(cId, cand);
        }
      }

      const enrichedCandidates: any[] = [];

      for (const id of allCandidateIdStrings) {
        const keywordMatch = dedupedKeywordsMap.get(id);
        const vectorScore = vectorResultsMap.get(id);
        const cand = candidatesMap.get(id);

        if (!cand) continue;

        if (vectorScore !== undefined) {
          // If returned by vector search, use vector search score
          enrichedCandidates.push({
            candidate: cand,
            vectorScore,
          });
        } else if (keywordMatch) {
          // If only returned by keyword search, calculate cosine similarity dynamically
          const resume: any = keywordResumeMap.get(id as Id<"candidates">);
          if (resume && resume.embedding && resume.embedding.length > 0) {
            const similarity = cosineSimilarity(jobEmbedding, resume.embedding);
            enrichedCandidates.push({
              candidate: cand,
              vectorScore: similarity,
            });
          }
        }
      }

      // Add existing TA-acted candidates not in allCandidateIdStrings with default score
      for (const cId of existingToKeepIds) {
        if (!allCandidateIdStrings.has(cId)) {
          const cand = candidatesMap.get(cId);
          if (cand) {
            enrichedCandidates.push({
              candidate: cand,
              vectorScore: 0.5, // Default mid score
            });
          }
        }
      }

      // 6. Current-Role Level Gate & Role-Family Classification
      // Derive/retrieve job role family & fingerprint
      const currentJobFingerprint = `${job.title} | ${(job.jobDescription || "").slice(0, 100)} | ${job.seniorityLevel}`;
      let jobRoleFamily = job.roleFamily || "other";
      if (!job.roleFamily || job.roleFamilyCacheFingerprint !== currentJobFingerprint) {
        const jobClassified = await classifyJobRoleFamily(ctx, job.title, job.jobDescription, job.seniorityLevel);
        jobRoleFamily = jobClassified.roleFamily;
      }

      const jobRank = mapJobSeniorityTo10LevelRank(job.seniorityLevel);

      // Identify candidates needing classification (fingerprint checking)
      const candidatesToClassify: any[] = [];
      const candidateClassificationCache = new Map<string, any>();

      for (const item of enrichedCandidates) {
        const cv = item.candidate;
        const candFingerprint = `${cv.currentJobTitle || cv.currentTitle || ""} | ${cv.currentEmployer || ""} | ${cv.sector || ""}`;
        if (
          cv.currentRoleCacheFingerprint === candFingerprint &&
          (cv.currentRoleRank !== undefined || cv.currentRoleConfidence === "low") &&
          cv.roleFamily
        ) {
          candidateClassificationCache.set(cv._id.toString(), {
            candidateId: cv._id.toString(),
            rank: cv.currentRoleRank ?? null,
            rankLabel: cv.currentRoleRankLabel || "Unclassified",
            confidence: cv.currentRoleConfidence || "high",
            reasoning: "Cached current-role classification",
            usedFallbackTitle: cv.usedFallbackTitle || false,
            roleFamily: cv.roleFamily,
            roleFamilyMatch: (cv.roleFamily === jobRoleFamily) ? "exact" : (cv.roleFamily === "other" || jobRoleFamily === "other") ? "synonym" : "unrelated",
            exclusionReason: null,
          });
        } else {
          candidatesToClassify.push(cv);
        }
      }

      // Run LLM classification for un-cached candidates in batches of 20
      if (candidatesToClassify.length > 0) {
        const newClassifications = await classifyCurrentRolesBatch(ctx, candidatesToClassify, job.title, jobRoleFamily);
        const dbUpdates: any[] = [];

        newClassifications.forEach((res, cid) => {
          const cidStr = cid.toString();
          candidateClassificationCache.set(cidStr, res);
          const candObj = candidatesMap.get(cidStr);
          if (candObj) {
            const candFingerprint = `${candObj.currentJobTitle || candObj.currentTitle || ""} | ${candObj.currentEmployer || ""} | ${candObj.sector || ""}`;
            dbUpdates.push({
              candidateId: candObj._id,
              currentRoleRank: res.rank,
              currentRoleRankLabel: res.rankLabel,
              currentRoleConfidence: res.confidence,
              roleFamily: res.roleFamily,
              currentRoleCacheFingerprint: candFingerprint,
              usedFallbackTitle: res.usedFallbackTitle,
            });
          }
        });

        if (dbUpdates.length > 0) {
          await ctx.runMutation(api.candidates.candidates.updateCandidateRoleCacheBatch, { updates: dbUpdates });
        }
      }

      const matchResults = enrichedCandidates
        .map((c, index) => {
          const cv = c.candidate;
          const cvIdStr = cv._id.toString();

          const classRes = candidateClassificationCache.get(cvIdStr) || {
            rank: null,
            rankLabel: "Unclassified",
            confidence: "low",
            reasoning: "Fail-open default",
            usedFallbackTitle: false,
            roleFamily: "unknown",
            roleFamilyMatch: "synonym",
            exclusionReason: null,
          };

          const candRank = classRes.rank;
          let currentRoleGate: "pass" | "pass_with_penalty" | "excluded_overqualified" | "skipped_other" = "pass";
          let currentRolePenalty = 0;
          let exclusionReason: string | null = null;

          if (jobRank === null) {
            currentRoleGate = "skipped_other";
          } else if (candRank === null) {
            currentRoleGate = "pass";
          } else {
            const delta = jobRank - candRank;
            if (delta < 0) {
              currentRoleGate = "excluded_overqualified";
              exclusionReason = classRes.exclusionReason || `Candidate's current role level (${classRes.rankLabel}) exceeds target job level.`;
            } else if (delta === 0 || delta === 1) {
              currentRoleGate = "pass";
            } else {
              currentRoleGate = "pass_with_penalty";
              currentRolePenalty = Math.max(-40, -12 * (delta - 1));
            }
          }

          const seniorityConflict = checkSeniorityConflict(candRank, cv.seniorityLevel);

          const cvPayload = {
            _id: cv._id,
            fullName: cv.fullName,
            email: cv.email,
            phone: cv.phone,
            location: cv.location,
            currentTitle: cv.currentTitle || cv.currentJobTitle,
            currentJobTitle: cv.currentJobTitle || cv.currentTitle,
            currentEmployer: cv.currentEmployer,
            seniorityLevel: cv.seniorityLevel,
            yearsOfExperience: cv.yearsOfExperience ?? cv.totalExperienceYears,
            totalExperienceYears: cv.totalExperienceYears ?? cv.yearsOfExperience,
            skills: cv.skills,
            summary: cv.summary || cv.rawText?.slice(0, 500),
            rawText: cv.rawText,
            educationDegree: cv.educationDegree,
            educationInstitution: cv.educationInstitution,
            educationYear: cv.educationYear,
            expectedSalary: cv.expectedSalary,
            availability: cv.availability,
            languages: cv.languages,
            certifications: cv.certifications,
            noticePeriodDays: cv.noticePeriodDays,
          };

          const reqSkills = [
            ...(synthesized.coreDomainSkills ?? []),
            ...(job.requiredSkills ?? []),
            ...(parsedPreferences.requiredSkillsOverride ?? []),
          ];

          const scored = scoreCandidateAgainstRequirements(cvPayload, {
            title: synthesized.primaryRoleTitle || job.title,
            requiredSkills: reqSkills,
            niceToHaveSkills: [
              ...(synthesized.generalCommercialSkills ?? []),
              ...(job.niceToHaveSkills ?? []),
            ],
            minYearsExperience: parsedPreferences.minYearsExperience ?? job.experienceMinYears ?? null,
            maxYearsExperience: parsedPreferences.maxYearsExperience ?? job.experienceMaxYears ?? null,
            overrideSeniority: parsedPreferences.overrideSeniority ?? null,
            overrideLocation: parsedPreferences.overrideLocation ?? null,
            strictLocation: parsedPreferences.strictLocation ?? false,
            domainPreference: parsedPreferences.domainPreference ?? null,
            companyTypePreference: parsedPreferences.companyTypePreference ?? null,
            requiredCertifications: parsedPreferences.requiredCertifications ?? [],
            negativeKeywords: [
              ...(synthesized.distractorWordsToIgnore ?? []),
              ...(parsedPreferences.negativeKeywords ?? []),
            ],
            education: job.educationLevel ?? null,
            languages: job.languagesRequired ?? [],
            location: job.location,
            industry: synthesized.targetDomain || job.clientIndustry,
            seniority: job.seniorityLevel,
            summary: job.jobDescription,
            keywords: [],
            currentRolePenalty,
            roleFamilyMatch: classRes.roleFamilyMatch,
          }, index);

          // Calibrated NVIDIA E5 vector similarity score (baseline floor at 0.45)
          const rawVector = c.vectorScore ?? 0.4;
          let normVectorScore = 0;
          if (rawVector >= 0.45) {
            normVectorScore = Math.min(100, Math.round(30 + ((rawVector - 0.45) / 0.30) * 70));
          } else {
            normVectorScore = Math.max(0, Math.round((rawVector / 0.45) * 30));
          }

          // Blend 55% heuristic score with 45% calibrated vector similarity
          let matchScore = Math.round(
            (scored.overallScore * 0.55) + (normVectorScore * 0.45)
          );

          // Apply Soft Weighted Domain Multiplier (1.15x for exact domain match, 0.75x for unrelated domain)
          if (classRes.roleFamilyMatch === "exact") {
            matchScore = Math.min(100, Math.round(matchScore * 1.15));
          } else if (classRes.roleFamilyMatch === "unrelated") {
            matchScore = Math.round(matchScore * 0.75);
          }

          // Domain Gate Enforcement for Specialized Domains (e.g. Tea Trading, Plantations)
          const candidateText = `${cv.currentTitle || ""} ${cv.currentJobTitle || ""} ${(cv.skills || []).join(" ")} ${cv.summary || ""}`.toLowerCase();
          const targetDomainNorm = (synthesized.targetDomain || job.clientIndustry || "").toLowerCase();
          const coreDomainKey = (synthesized.coreDomainSkills?.[0] || "").toLowerCase();

          const hasDomainKeywords = (
            (coreDomainKey && candidateText.includes(coreDomainKey)) ||
            (targetDomainNorm && candidateText.includes(targetDomainNorm)) ||
            (synthesized.coreDomainSkills || []).some((ds) => ds.length > 2 && candidateText.includes(ds.toLowerCase()))
          );

          const isSpecializedDomain = targetDomainNorm.includes("tea") || targetDomainNorm.includes("plant") || coreDomainKey.includes("tea");
          if (isSpecializedDomain && !hasDomainKeywords) {
            matchScore = Math.min(matchScore, 42); // Hard cap below minMatchScoreToShow (60)
          }

          // Build authoritative AI Talent Acquisition reason
          const name = cv.fullName || "Candidate";
          const role = cv.currentTitle || cv.currentJobTitle || "Professional";
          const expYears = cv.totalExperienceYears || cv.yearsOfExperience;
          const matchedList = (scored.matchedRequired || []).slice(0, 4);
          const missingList = (scored.missingRequired || []).slice(0, 3);

          // Determine job's primary skill domain for match confidence
          const jobSkillDomains = new Set(
            reqSkills.map((s: string) => getSkillDomain(s)).filter((d: string) => d !== "unknown")
          );
          const primaryJobDomain = jobSkillDomains.size > 0 ? [...jobSkillDomains][0] : "unknown";

          // Check how many matched skills align with the job's domain
          const matchedDomains = new Set(
            (scored.matchedRequired || []).map((s: string) => getSkillDomain(s))
          );
          const domainAlignedMatches = [...matchedDomains].filter((d: string) => d === primaryJobDomain).length;
          const totalMatches = matchedList.length;

          let matchConfidence: "high" | "medium" | "low" = "low";
          if (domainAlignedMatches >= 3) matchConfidence = "high";
          else if (domainAlignedMatches >= 1) matchConfidence = "medium";
          // If job has no known domain skills (e.g. all custom), default to medium
          if (primaryJobDomain === "unknown" && totalMatches > 0) matchConfidence = "medium";

          let aiReasonParts: string[] = [];
          
          if (activePreferences && activePreferences.trim()) {
            aiReasonParts.push(`Evaluated with custom TA criteria: "${activePreferences.trim()}".`);
          }

          if (matchScore >= 75) {
            aiReasonParts.push(`Highly recommended TA match for ${job.title}. ${name} shows strong domain alignment as a ${role}.`);
          } else if (matchScore >= 60) {
            aiReasonParts.push(`Suitable candidate for ${job.title} with relevant background as a ${role}.`);
          } else {
            aiReasonParts.push(`Partial match for ${job.title} based on background as a ${role}.`);
          }

          if (matchedList.length > 0) {
            aiReasonParts.push(`Key matching skills: ${matchedList.join(", ")}.`);
            // Flag weak/tangential skill matches
            if (matchConfidence === "low" && totalMatches > 0) {
              aiReasonParts.push(`Note: Matched skills may be tangentially related — verify domain relevance.`);
            }
          }
          if (expYears) {
            aiReasonParts.push(`Brings ${expYears} years of total professional experience.`);
          }
          if (missingList.length > 0) {
            aiReasonParts.push(`Skill gaps to verify: ${missingList.join(", ")}.`);
          }

          const professionalAiReason = aiReasonParts.join(" ");

          return {
            cvId: cv._id,
            overallScore: matchScore,
            breakdown: {
              skills: scored.skillScore,
              experience: scored.experienceScore,
              seniority: scored.seniorityScore,
              industry: scored.industryScore,
              location: scored.locationScore,
            },
            matchedSkills: scored.matchedRequired,
            missingSkills: scored.missingRequired,
            reason: professionalAiReason,
            sourceLevel1: cv.firstSourceChannel ?? undefined,
            sourceLevel2: cv.firstSourceJobId ?? undefined,
            candidateName: cv.fullName ?? undefined,
            candidateRole: cv.currentTitle ?? cv.currentJobTitle ?? undefined,
            candidateExp: cv.yearsOfExperience ?? cv.totalExperienceYears ?? undefined,

            // 10+ Audit Log Fields
            currentRoleRank: candRank ?? undefined,
            currentRoleRankLabel: classRes.rankLabel,
            currentRoleConfidence: classRes.confidence,
            usedFallbackTitle: classRes.usedFallbackTitle,
            currentRoleGate,
            currentRolePenalty,
            seniorityConflict,
            exclusionReason,
            roleFamily: classRes.roleFamily,
            roleFamilyMatch: classRes.roleFamilyMatch,

            // Location Gate Audit Fields
            locationStatus: scored.locationStatus,
            locationGate: scored.locationGate,
            locationPenalty: scored.locationPenalty,
          };
        });

      // Sort all candidates by overall score descending (highest score to lowest/good score)
      matchResults.sort((a, b) => b.overallScore - a.overallScore);

      // Filter Gate: Filter match scores >= 60%
      const safetyFloor = 60;
      let validMatches = matchResults.filter(r => {
        if (r.overallScore < safetyFloor) return false;
        if (r.currentRoleGate === "excluded_overqualified" && !appliedCandidateIds.has(r.cvId)) {
          return false; // Hard exclude new candidates whose current role level exceeds job target rank
        }
        if (r.locationGate === "excluded_mismatch" && !appliedCandidateIds.has(r.cvId)) {
          return false; // Hard exclude candidates with explicit location mismatch
        }
        return true;
      });

      // Mandatory Zero-Result Fallback: If 0 candidates meet safetyFloor (60%), surface top 10 nearest candidates labeled with advisory tag
      if (validMatches.length === 0 && matchResults.length > 0) {
        validMatches = matchResults.slice(0, 10).map(r => ({
          ...r,
          reason: `[Outside typical domain / Review manually] ${r.reason}`
        }));
      }

      // Slice the top 30 ordered highest to lowest
      const newTop30 = validMatches.slice(0, 30);
      const newTop30Ids = new Set(newTop30.map(r => r.cvId));

      // Append any previously matched TA-acted candidates who fell out of the top 30
      const extraExistingMatches = matchResults.filter(
        r => existingToKeepIds.includes(r.cvId) && !newTop30Ids.has(r.cvId)
      );

      const finalResults = [...newTop30, ...extraExistingMatches];

      await ctx.runMutation(internal.jobs.jobs.saveReverseMatchResults, {
        jobId: args.jobId,
        roleFamily: jobRoleFamily,
        roleFamilyCacheFingerprint: currentJobFingerprint,
        results: finalResults,
        status: "done",
      });

      if (tokenLogs.length > 0) {
        await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
          logs: tokenLogs,
        });
      }

    } catch (e) {
      console.error("Reverse match vector search error:", e);
      const job = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: args.jobId });
      await ctx.runMutation(internal.jobs.jobs.saveReverseMatchResults, {
        jobId: args.jobId,
        results: job?.reverseMatchResults || [],
        status: "error",
      });

      if (tokenLogs.length > 0) {
        try {
          await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
            logs: tokenLogs,
          });
        } catch (logErr) {
          console.error("Failed to write token logs on error path:", logErr);
        }
      }
    }
  },
});

/**
 * Action to recursively backfill embeddings for all candidate resumes in batches.
 * Paced at 40 candidates per run with 12s delay to respect NVIDIA rate limits (40 RPM).
 * At this pace: 115,000 / 40 = 2,875 batches x 12s = ~9.5 hours for full corpus.
 */
export const backfillCandidateEmbeddings = action({
  args: { batchSize: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ processed: number; remaining: number; continueCursor?: string }> => {
    const limit = args.batchSize ?? 40;

    // Find resumes missing embeddings using paginated scan
    const result = await ctx.runQuery(internal.matching.queries.getCandidateResumesMissingEmbeddings, {
      limit,
      cursor: args.cursor,
    });

    const missing = result.missing;

    if (missing.length === 0) {
      if (!result.isDone) {
        // If we hit the end of this batch's scan but there are still pages left in the DB, schedule next page scan
        await ctx.scheduler.runAfter(12000, api.matching.agent2.backfillCandidateEmbeddings, {
          batchSize: limit,
          cursor: result.continueCursor ?? undefined,
        });
      }
      return { processed: 0, remaining: result.isDone ? 0 : 999 };
    }

    let processed = 0;
    const tokenLogs: any[] = [];
    for (const resume of missing) {
      try {
        if (resume.rawText && resume.rawText.trim()) {
          const textToEmbed = resume.rawText.slice(0, 15000);
          const embedResult = await embedText(textToEmbed, "passage");
          const embedding = embedResult.embedding;
          await ctx.runMutation(internal.matching.queries.updateCandidateEmbedding, {
            candidateId: resume.candidateId,
            embedding,
          });
          tokenLogs.push({
            taskType: "embedding",
            model: embedResult.usage.model,
            promptTokens: embedResult.usage.promptTokens,
            completionTokens: 0,
            success: true,
          });
          processed++;
        } else {
          // If candidate resume has no raw text, embed a dummy text to avoid infinite loops
          const embedResult = await embedText("Empty resume profile placeholder", "passage");
          const embedding = embedResult.embedding;
          await ctx.runMutation(internal.matching.queries.updateCandidateEmbedding, {
            candidateId: resume.candidateId,
            embedding,
          });
          tokenLogs.push({
            taskType: "embedding",
            model: embedResult.usage.model,
            promptTokens: embedResult.usage.promptTokens,
            completionTokens: 0,
            success: true,
          });
          processed++;
        }
      } catch (err) {
        console.error(`Failed to backfill embedding for candidate ${resume.candidateId}:`, err);
        tokenLogs.push({
          taskType: "embedding",
          model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
          promptTokens: 0,
          completionTokens: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (tokenLogs.length > 0) {
      try {
        await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
          logs: tokenLogs,
        });
      } catch (logErr) {
        console.error("Failed to write backfill token logs:", logErr);
      }
    }

    if (!result.isDone) {
      // Pacing delay: 12 seconds between batches — safe under NVIDIA NIM 40 RPM rate limit
      // (40 candidates per batch at ~15 API calls = well within 40 RPM)
      await ctx.scheduler.runAfter(12000, api.matching.agent2.backfillCandidateEmbeddings, {
        batchSize: limit,
        cursor: result.continueCursor ?? undefined,
      });
    }

    return {
      processed,
      remaining: result.isDone ? 0 : 999,
      continueCursor: result.continueCursor ?? undefined,
    };
  },
});

export const runEmpiricalVectorBenchmark = action({
  args: {},
  handler: async (ctx): Promise<any> => {
    // 1. Fetch sample jobs & candidates
    const recentCandidates = await ctx.runQuery(api.matching.queries.getRecentCandidates, { limit: 100 });
    const jobs = await ctx.runQuery(api.jobs.jobs.list, {});
    
    if (!jobs || jobs.length === 0 || !recentCandidates || recentCandidates.length === 0) {
      return { error: "Insufficient sample data in database" };
    }

    const sampleJob = jobs[0]; // e.g. Tech / Engineering Job
    const jobText = `Title: ${sampleJob.title}\nDescription: ${sampleJob.jobDescription}\nSkills: ${(sampleJob.requiredSkills || []).join(", ")}`;
    
    const jobEmbed = await embedText(jobText, "query");

    const pairResults: Array<{
      candidateId: string;
      fullName: string;
      currentTitle: string;
      roleFamily: string;
      isKnownGood: boolean;
      cosineSimilarity: number;
    }> = [];

    const knownGood: number[] = [];
    const knownBad: number[] = [];

    // Evaluate top 30 candidates against sample job embedding
    const sampleCandidates = recentCandidates.slice(0, 30);

    for (const cand of sampleCandidates) {
      const resume = await ctx.runQuery(internal.matching.queries.getCandidateResume, { candidateId: cand._id });
      if (!resume || !resume.rawText) continue;

      const candText = resume.rawText.slice(0, 4000);
      try {
        const candEmbed = await embedText(candText, "passage");
        const sim = cosineSimilarity(jobEmbed.embedding, candEmbed.embedding);

        const candRole = (cand.currentTitle || cand.currentJobTitle || "").toLowerCase();
        const jobTitleLower = (sampleJob.title || "").toLowerCase();
        
        // Determine known good vs known bad based on title keywords
        const isGood = candRole.includes("engineer") || candRole.includes("developer") || candRole.includes("software") || candRole.includes("tech");
        
        pairResults.push({
          candidateId: cand._id,
          fullName: cand.fullName || "Anonymous Candidate",
          currentTitle: cand.currentTitle || cand.currentJobTitle || "Unspecified",
          roleFamily: cand.roleFamily || "unclassified",
          isKnownGood: isGood,
          cosineSimilarity: Number(sim.toFixed(4)),
        });

        if (isGood) knownGood.push(sim);
        else knownBad.push(sim);

      } catch (err) {
        console.error(`Failed embedding candidate ${cand._id}:`, err);
      }
    }

    const calcAvg = (arr: number[]) => arr.length > 0 ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)) : 0;
    const calcMin = (arr: number[]) => arr.length > 0 ? Number(Math.min(...arr).toFixed(4)) : 0;
    const calcMax = (arr: number[]) => arr.length > 0 ? Number(Math.max(...arr).toFixed(4)) : 0;

    return {
      sampleJobEvaluated: {
        jobId: sampleJob._id,
        title: sampleJob.title,
        industry: sampleJob.clientIndustry,
      },
      distributionSummary: {
        knownGoodCount: knownGood.length,
        knownGoodMin: calcMin(knownGood),
        knownGoodMax: calcMax(knownGood),
        knownGoodAvg: calcAvg(knownGood),
        knownBadCount: knownBad.length,
        knownBadMin: calcMin(knownBad),
        knownBadMax: calcMax(knownBad),
        knownBadAvg: calcAvg(knownBad),
      },
      pairResults,
    };
  },
});
