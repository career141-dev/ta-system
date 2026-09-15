"use node";

import { executeLLMWithNvidiaFallback } from "./llm";

export interface CandidateForRoleClassification {
  _id: string;
  currentJobTitle?: string | null;
  currentEmployer?: string | null;
  sector?: string | null;
  totalExperienceYears?: number | null;
  pastJobTitles?: string[] | null;
}

export interface CandidateRoleClassificationResult {
  candidateId: string;
  rank: number | null; // 0 to 9, or null if fail-open/skipped
  rankLabel: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  usedFallbackTitle: boolean;
  roleFamily: string; // e.g. software_engineering, fmcg_sales, other
  roleFamilyMatch: "exact" | "synonym" | "adjacent" | "unrelated";
  exclusionReason: string | null;
  errorReason?: string;
}

const BATCH_SIZE = 20;

/**
 * Classify a job's function into a normalized role family slug.
 */
export async function classifyJobRoleFamily(
  ctx: any,
  jobTitle: string,
  jobDescription?: string,
  seniorityLevel?: string
): Promise<{ roleFamily: string; reasoning: string }> {
  try {
    const prompt = `Analyze this job posting and assign a normalized role family slug (snake_case).
Examples: software_engineering, qa_testing, devops_cloud, data_ai, product_management, design_uiux, fmcg_sales, B2B_sales, finance_accounting, hr_recruitment, marketing, operations_logistics, civil_engineering, textile_merchandising, tea_trading, medical_nursing, legal, executive_management, other.
If the job function is specialized or non-standard, assign a descriptive snake_case tag or "other".

Job Title: ${jobTitle}
Seniority: ${seniorityLevel || "Not specified"}
Description snippet: ${(jobDescription || "").slice(0, 300)}

Return ONLY valid JSON matching:
{
  "roleFamily": "snake_case_string",
  "reasoning": "short explanation"
}`;

    const { content } = await executeLLMWithNvidiaFallback(ctx, "jd_matching", {
      messages: [
        { role: "system", content: "You are an expert talent acquisition classifier." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(content || "{}");
    const roleFamily = typeof parsed.roleFamily === "string" && parsed.roleFamily.trim()
      ? parsed.roleFamily.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_")
      : "other";

    return {
      roleFamily: roleFamily || "other",
      reasoning: parsed.reasoning || "Derived job role family",
    };
  } catch (err) {
    console.error("Failed to classify job role family:", err);
    return {
      roleFamily: "other",
      reasoning: "Fallback role family due to classification error",
    };
  }
}

/**
 * Classify a batch of candidate profiles for 10-level Corporate Rank and Role-Family Equivalence.
 * Max batch size = 20. Fail-open error isolation applied per candidate.
 */
export async function classifyCurrentRolesBatch(
  ctx: any,
  candidates: CandidateForRoleClassification[],
  jobTitle: string,
  jobRoleFamily: string
): Promise<Map<string, CandidateRoleClassificationResult>> {
  const resultMap = new Map<string, CandidateRoleClassificationResult>();

  if (candidates.length === 0) return resultMap;

  // Cap un-cached candidate classifications to top 20 candidates (1 chunk max per reverse match run)
  const candidateInputs = candidates.slice(0, BATCH_SIZE).map((c) => {
    let titleToUse = c.currentJobTitle;
    let usedFallback = false;

    if (!titleToUse && c.pastJobTitles && c.pastJobTitles.length > 0) {
      titleToUse = c.pastJobTitles[0];
      usedFallback = true;
    }

    return {
      candidateId: c._id.toString(),
      title: titleToUse || "Unspecified Role",
      employer: c.currentEmployer || "Unspecified Employer",
      sector: c.sector || "Unspecified Sector",
      experienceYears: c.totalExperienceYears ?? 0,
      usedFallback,
    };
  });

  const prompt = `You are a corporate executive taxonomy engine. Evaluate the candidate's CURRENT role title, employer context, and experience level for:
1. "rank": Integer from 0 to 9 representing their corporate seniority level:
   - 0: Intern / Apprentice
   - 1: Entry-Level / Junior Individual Contributor (0-2 yrs)
   - 2: Mid-Level Individual Contributor (2-5 yrs)
   - 3: Senior Individual Contributor / Technical Lead / Specialist (5-8+ yrs)
   - 4: Lead / Assistant Manager / Team Lead (first-line supervisor)
   - 5: Manager / Section Head (manages teams/budget)
   - 6: Senior Manager / Head of Department (manages managers or large business unit)
   - 7: Assistant General Manager (AGM) / Deputy General Manager (DGM)
   - 8: General Manager (GM) / Vice President (VP) / Country Manager
   - 9: Director / C-Suite (CEO, CTO, CFO, Managing Director)

2. "roleFamily": Assign a normalized snake_case role family slug representing candidate's CURRENT function (e.g. software_engineering, qa_testing, devops_cloud, data_ai, product_management, design_uiux, fmcg_sales, B2B_sales, finance_accounting, hr_recruitment, marketing, operations_logistics, civil_engineering, textile_merchandising, tea_trading, medical_nursing, legal, executive_management, other).

3. "roleFamilyMatch": Evaluate equivalence between candidate's roleFamily and Target Job Role Family ("${jobRoleFamily}"):
   - "exact": Direct match (e.g. candidate is software_engineering for software_engineering job)
   - "synonym": Functionally equivalent / alternate title for same domain (e.g. B2B_sales vs fmcg_sales, or devops_cloud vs software_engineering)
   - "adjacent": Transferable domain / close cousin (e.g. qa_testing for software_engineering, or product_management for software_engineering)
   - "unrelated": Completely different non-transferable domain (e.g. civil_engineering or tea_trading for software_engineering)

4. "exclusionReason": Set to null IF rank <= 7. BUT if rank >= 8 (GM, Director, C-Suite) AND target job title is non-executive ("${jobTitle}"), return a clear string explaining over-qualification.

Target Job Title: "${jobTitle}"
Target Job Role Family: "${jobRoleFamily}"

Candidates to evaluate (JSON map by candidate ID):
${JSON.stringify(candidateInputs, null, 2)}

Return ONLY valid JSON matching:
{
  "<candidateId>": {
    "rank": 0-9 (integer),
    "rankLabel": "Entry-Level" | "Mid-Level" | "Executive" | "Senior Executive" | "Manager" | "Senior Manager" | "AGM" | "GM" | "Director" | "C-Suite",
    "confidence": "high" | "medium" | "low",
    "reasoning": "short 1-sentence explanation",
    "roleFamily": "snake_case_string (or 'other')",
    "roleFamilyMatch": "exact" | "synonym" | "adjacent" | "unrelated",
    "exclusionReason": string or null (if candidate's current role rank exceeds target job level, describe specifically why overqualified, e.g. "Candidate's current level (Senior Manager) exceeds target job level")
  }
}`;

  try {
    const { content } = await executeLLMWithNvidiaFallback(ctx, "jd_matching", {
      messages: [
        { role: "system", content: "You are an expert talent acquisition classifier. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    });

    let cleanJson = (content || "{}").trim();
    if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }

    let parsedObj: any = {};
    try {
      parsedObj = JSON.parse(cleanJson);
    } catch {
      // Auto-repair common LLM JSON syntax issues (trailing commas, unquoted keys)
      const fixed = cleanJson
        .replace(/,\s*([\]}])/g, "$1")
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
      try {
        parsedObj = JSON.parse(fixed);
      } catch {
        parsedObj = {};
      }
    }

    for (const item of candidateInputs) {
      const cid = item.candidateId;
      const parsed = parsedObj[cid] || parsedObj;

      if (parsed && typeof parsed === "object" && typeof parsed.rank === "number") {
        const rank = Math.max(0, Math.min(9, Math.round(parsed.rank)));
        const confidence = parsed.usedFallback ? "medium" : (parsed.confidence || "high");
        const roleFamilyMatch = ["exact", "synonym", "adjacent", "unrelated"].includes(parsed.roleFamilyMatch)
          ? parsed.roleFamilyMatch
          : "synonym";

        resultMap.set(cid, {
          candidateId: cid,
          rank,
          rankLabel: parsed.rankLabel || `Rank ${rank}`,
          confidence: (confidence === "high" || confidence === "medium" || confidence === "low") ? confidence : "medium",
          reasoning: parsed.reasoning || "Classified current corporate role level",
          usedFallbackTitle: item.usedFallback,
          roleFamily: (typeof parsed.roleFamily === "string" && parsed.roleFamily.trim()) ? parsed.roleFamily.trim().toLowerCase() : "other",
          roleFamilyMatch,
          exclusionReason: typeof parsed.exclusionReason === "string" ? parsed.exclusionReason : null,
        });
      } else {
        // Fail-open for single candidate schema failure
        resultMap.set(cid, createFailOpenResult(cid, item.usedFallback, "item_schema_mismatch"));
      }
    }
  } catch (err) {
    console.error("Batch classification failed (applying fail-open policy to chunk):", err);
    // Fail-open policy for whole batch
    for (const item of candidateInputs) {
      resultMap.set(item.candidateId, createFailOpenResult(item.candidateId, item.usedFallback, "classification_failed"));
    }
  }

  return resultMap;
}

function createFailOpenResult(
  candidateId: string,
  usedFallbackTitle: boolean,
  errorReason: string
): CandidateRoleClassificationResult {
  return {
    candidateId,
    rank: null,
    rankLabel: "Unclassified",
    confidence: "low",
    reasoning: "Classification failed-open due to infrastructure/timeout error",
    usedFallbackTitle,
    roleFamily: "unknown",
    roleFamilyMatch: "synonym", // Neutral 1.0x multiplier on fail-open
    exclusionReason: null,
    errorReason,
  };
}
