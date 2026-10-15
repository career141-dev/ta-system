import "server-only";

import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { EMPTY_CRITERIA, type Candidate, type SearchCriteria } from "@/data/types";
import type { ReferenceCvBlueprint } from "./referenceCv";
import { engineSearch } from "./engineSearch";
import { seniorityRank } from "../../convex/cvs/cvScoring";

export interface LookalikeCandidateMatch {
  candidate: Candidate;
  score: number; // 0 - 100
  rating: "Exceptional Lookalike" | "Strong Lookalike" | "Good Fit" | "Partial Match";
  sharedSkills: string[];
  missingSkills: string[];
  experienceDeltaYears: number;
  matchedEmployers: string[];
  matchedIndustries: string[];
  matchSummary: string;
}

export interface LookalikeSearchResults {
  blueprint: ReferenceCvBlueprint;
  prompt: string;
  totalHits: number;
  matches: LookalikeCandidateMatch[];
}

function normalizeToken(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#+./\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Evaluates candidate similarity against a reference CV blueprint.
 */
export function scoreLookalikeCandidate(
  c: Candidate,
  bp: ReferenceCvBlueprint,
  prompt = ""
): LookalikeCandidateMatch {
  // 1. Role & Seniority alignment (weight 30%)
  const refTitleTokens = normalizeToken(bp.targetTitle).split(" ").filter((t) => t.length > 2);
  const candTitleTokens = normalizeToken(c.currentTitle ?? "").split(" ").filter((t) => t.length > 2);
  
  let titleTokenOverlap = 0;
  for (const t of refTitleTokens) {
    if (candTitleTokens.includes(t)) titleTokenOverlap++;
  }
  const titleScore = refTitleTokens.length > 0 ? (titleTokenOverlap / refTitleTokens.length) * 100 : 50;

  // Seniority difference
  const refSeniority = seniorityRank(bp.seniority);
  const candSeniority = seniorityRank(c.currentTitle);
  const seniorityDistance = Math.abs((refSeniority >= 0 ? refSeniority : 2) - (candSeniority >= 0 ? candSeniority : 2));
  const seniorityScore = Math.max(20, 100 - seniorityDistance * 25);

  const roleScore = titleScore * 0.6 + seniorityScore * 0.4;

  // 2. Skills overlap (weight 35%)
  const candSkillsNormalized = (c.skills ?? []).map(normalizeToken);
  const sharedSkills: string[] = [];
  const missingSkills: string[] = [];

  for (const refSkill of bp.skills) {
    const norm = normalizeToken(refSkill);
    const match = candSkillsNormalized.some((cs) => cs.includes(norm) || norm.includes(cs));
    if (match) {
      sharedSkills.push(refSkill);
    } else {
      missingSkills.push(refSkill);
    }
  }

  const skillsScore = bp.skills.length > 0 ? Math.min(100, (sharedSkills.length / bp.skills.length) * 100 + 10) : 50;

  // 3. Experience delta (weight 15%)
  const refExp = bp.totalExperienceYears ?? 5;
  const candExp = c.totalExperienceYears ?? 0;
  const expDelta = candExp - refExp;
  const absDelta = Math.abs(expDelta);

  let expScore = 100;
  if (absDelta <= 1) expScore = 100;
  else if (absDelta <= 2) expScore = 90;
  else if (absDelta <= 4) expScore = 75;
  else if (absDelta <= 6) expScore = 55;
  else expScore = 35;

  // 4. Employers and Industries (weight 10%)
  const matchedEmployers: string[] = [];
  const matchedIndustries: string[] = [];
  const allCandEmployers = [c.currentEmployer, ...(c.workHistory ?? []).map((h) => h.employer)]
    .filter(Boolean)
    .map((e) => normalizeToken(e!));

  for (const refEmp of bp.employers) {
    const norm = normalizeToken(refEmp);
    if (allCandEmployers.some((ce) => ce.includes(norm) || norm.includes(ce))) {
      matchedEmployers.push(refEmp);
    }
  }

  const allCandIndustries = (c.industries ?? []).map(normalizeToken);
  for (const refInd of bp.industries) {
    const norm = normalizeToken(refInd);
    if (allCandIndustries.some((ci) => ci.includes(norm) || norm.includes(ci))) {
      matchedIndustries.push(refInd);
    }
  }

  const employerScore = matchedEmployers.length > 0 ? 100 : matchedIndustries.length > 0 ? 75 : 40;

  // 5. Recruiter Prompt Guidance
  let baseScore = roleScore * 0.35 + skillsScore * 0.4 + expScore * 0.15 + employerScore * 0.1;

  if (prompt.trim()) {
    const stopwords = new Set([
      "must", "have", "with", "experience", "candidate", "background", "skills",
      "should", "prefer", "preferred", "looking", "for", "from", "also", "good",
      "strong", "proven", "only", "plus",
    ]);
    const promptTokens = normalizeToken(prompt)
      .split(" ")
      .filter((t) => t.length > 2 && !stopwords.has(t));

    if (promptTokens.length > 0) {
      const candidateCorpus = [
        c.fullName,
        c.currentTitle,
        c.currentEmployer,
        ...(c.skills ?? []),
        ...(c.industries ?? []),
        c.qualifications,
        c.educationDegree,
        ...(c.workHistory ?? []).map((h) => `${h.title} ${h.employer}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchedPromptTokens = promptTokens.filter((pt) => candidateCorpus.includes(pt));
      const promptMatchRatio = matchedPromptTokens.length / promptTokens.length;
      // Boost candidate up to +15 points for satisfying prompt requirements
      const boost = (promptMatchRatio - 0.2) * 15;
      baseScore = Math.max(10, Math.min(100, baseScore + boost));
    }
  }

  // Composite Score
  const totalScore = Math.round(baseScore);

  let rating: LookalikeCandidateMatch["rating"] = "Partial Match";
  if (totalScore >= 85) rating = "Exceptional Lookalike";
  else if (totalScore >= 72) rating = "Strong Lookalike";
  else if (totalScore >= 58) rating = "Good Fit";

  // Build match summary
  const summaryParts: string[] = [];
  if (sharedSkills.length > 0) {
    summaryParts.push(`${sharedSkills.length} shared skill${sharedSkills.length === 1 ? "" : "s"} (${sharedSkills.slice(0, 3).join(", ")})`);
  }
  summaryParts.push(`${candExp} yrs exp vs ref ${refExp} yrs`);
  if (matchedEmployers.length > 0) {
    summaryParts.push(`Common company: ${matchedEmployers.join(", ")}`);
  } else if (matchedIndustries.length > 0) {
    summaryParts.push(`Same industry: ${matchedIndustries.join(", ")}`);
  }

  return {
    candidate: c,
    score: totalScore,
    rating,
    sharedSkills,
    missingSkills,
    experienceDeltaYears: expDelta,
    matchedEmployers,
    matchedIndustries,
    matchSummary: summaryParts.join(" · ") || "Comparable profile qualifications and career track.",
  };
}

/**
 * Searches and ranks lookalike candidates across the database based on the reference CV blueprint.
 */
export async function searchLookalikes(
  bp: ReferenceCvBlueprint,
  prompt = "",
  limit = 60
): Promise<LookalikeSearchResults> {
  const criteria: SearchCriteria = {
    ...EMPTY_CRITERIA,
    titles: [bp.targetTitle, ...(bp.alternativeTitles ?? [])].filter(Boolean),
    skills: bp.skills.slice(0, 8),
    employers: bp.employers.slice(0, 4),
    industries: bp.industries.slice(0, 3),
    minExperience: bp.minYears ?? 0,
    maxExperience: bp.maxYears ?? null,
  };

  const queryTerms = [bp.targetTitle, ...bp.skills.slice(0, 4), prompt.trim()].filter(Boolean).join(" ");

  let candidatePool: Candidate[] = [];

  if (isConvex()) {
    try {
      const searchRes = await engineSearch(queryTerms, criteria, limit, true);
      const ids = searchRes.hits.map((h) => h.candidateId);
      const docs = ids.map((id) => repo.candidate(id)).filter((c): c is Candidate => Boolean(c));
      candidatePool = docs;
    } catch (err) {
      console.warn("[lookalikeMatch] engineSearch fallback to repo:", err);
      candidatePool = repo.candidates();
    }
  } else {
    candidatePool = repo.candidates();
  }

  // Score all candidate pool items
  const matches = candidatePool
    .filter((c) => !c.cvFileMissing)
    .map((c) => scoreLookalikeCandidate(c, bp, prompt))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    blueprint: bp,
    prompt,
    totalHits: matches.length,
    matches,
  };
}
