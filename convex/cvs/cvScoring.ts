// @ts-nocheck
import { getOpenAI, getModelForTask, executeLLMWithNvidiaFallback } from "../lib/llm";
import type { SearchRequirements } from "../lib/jdParser";

function normalizeText(value: string): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#+./\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSkillForComparison(value: string): string {
  if (!value) return "";
  let s = value.toLowerCase().trim();

  // Canonicalize tech skill aliases preserving punctuation
  s = s
    .replace(/\bnode\s*(\.|\s*)js\b/g, "nodejs")
    .replace(/\breact\s*(\.|\s*)js\b/g, "reactjs")
    .replace(/\bvue\s*(\.|\s*)js\b/g, "vuejs")
    .replace(/\bnext\s*(\.|\s*)js\b/g, "nextjs")
    .replace(/\bexpress\s*(\.|\s*)js\b/g, "expressjs")
    .replace(/\bc\+\+\b/g, "cplusplus")
    .replace(/\bcpp\b/g, "cplusplus")
    .replace(/\bc#/g, "csharp")
    .replace(/\bc-sharp\b/g, "csharp")
    .replace(/\b\.net\b/g, "dotnet")
    .replace(/\bdotnet\b/g, "dotnet")
    .replace(/\bci\/cd\b/g, "cicd")
    .replace(/\bci-cd\b/g, "cicd")
    .replace(/\bpower\s*bi\b/g, "powerbi")
    .replace(/\bms\s*excel\b/g, "excel")
    .replace(/\bmicrosoft\s*excel\b/g, "excel")
    .replace(/\bsql\s*server\b/g, "sqlserver")
    .replace(/\bdata\s*analysis\b/g, "analytics");

  return normalizeText(s);
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 2);
}

export function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function titleTokens(value: string): string[] {
  const stopwords = new Set([
    "junior", "jr", "mid", "midlevel", "mid level",
    "senior", "sr", "lead", "principal", "assistant",
    "associate", "staff", "experienced", "seasoned",
    "entry", "entry level", "level",
  ]);
  return tokenize(value).filter((token) => !stopwords.has(token));
}

function skillTokens(value: string): string[] {
  return tokenize(value).filter((token) => token.length > 1);
}

function inferSeniorityFromText(text: string): string | null {
  const t = normalizeText(text);
  if (/\bintern\b/.test(t)) return "intern";
  if (/\bjunior\b|\bjr\b|\bentry level\b/.test(t)) return "junior";
  if (/\bmid level\b|\bmidlevel\b|\bmid\b/.test(t)) return "mid";
  if (/\bsenior\b|\bsr\b|\blead\b|\bprincipal\b|\bstaff\b/.test(t)) return "senior";
  if (/\bhead\b|\bdirector\b|\bvp\b|\bvice president\b|\bchief\b|\bcto\b|\bceo\b|\bcfo\b/.test(t)) return "executive";
  return null;
}

function extractTitleSeniorityToken(title: string): string | null {
  const norm = normalizeText(title);
  if (/\bintern\b/.test(norm)) return "intern";
  if (/\bjunior\b|\bjr\b|\bentry level\b/.test(norm)) return "junior";
  if (/\bsenior\b|\bsr\b/.test(norm)) return "senior";
  if (/\blead\b|\bprincipal\b|\bstaff\b|\bmanager\b/.test(norm)) return "lead";
  if (/\bdirector\b|\bhead\b|\bvp\b|\bchief\b|\bcto\b|\bceo\b/.test(norm)) return "executive";
  return null;
}

export function seniorityRank(value?: string | null): number {
  const s = (value ?? "").toLowerCase().trim();
  if (s === "intern") return 0;
  if (s === "junior" || s === "jr" || s === "entry_level" || s === "entry") return 1;
  if (s === "mid" || s === "mid_level") return 2;
  if (s === "senior" || s === "sr" || s === "senior_executive") return 3;
  if (s === "lead" || s === "principal" || s === "staff" || s === "manager" || s === "senior_manager" || s === "agm") return 4;
  if (s === "executive" || s === "director" || s === "c_suite" || s === "vp" || s === "gm") return 5;
  return -1;
}

export function calculateAsymmetricSeniorityScore(jobSeniority?: string | null, candidateSeniority?: string | null): number {
  if (!jobSeniority) return candidateSeniority ? 80 : 72;
  if (!candidateSeniority) return 70;

  const jRank = seniorityRank(jobSeniority);
  const cRank = seniorityRank(candidateSeniority);

  if (jRank < 0 || cRank < 0) return 70;

  const d = cRank - jRank;
  if (d === 0) return 100;

  if (d > 0) {
    // Over-qualification penalty (exponential continuous decay with floor at 5)
    return Math.max(5, Math.round(100 * Math.exp(-0.45 * Math.pow(d, 1.4))));
  } else {
    // Under-qualification penalty (linear decay with floor at 10)
    return Math.max(10, Math.round(100 - 22 * Math.abs(d)));
  }
}

function yearsScore(
  candidateYears: number | null | undefined,
  minimumYears: number | null,
  maximumYears?: number | null
): number {
  if (candidateYears == null) {
    if (minimumYears == null) return 75;
    return 65;
  }

  // Under-qualification check (below minimum required years)
  if (minimumYears != null && candidateYears < minimumYears) {
    const gap = minimumYears - candidateYears;
    if (gap <= 1) return 88;
    if (gap <= 2) return 76;
    if (gap <= 3) return 64;
    if (gap <= 5) return 50;
    return 35;
  }

  // Over-qualification check (exceeds maximum threshold)
  if (maximumYears != null && candidateYears > maximumYears) {
    const excess = candidateYears - maximumYears;
    if (excess <= 1) return 90;
    // Continuous exponential decay for excess experience above maximum threshold
    return Math.max(15, Math.round(100 * Math.exp(-0.30 * excess)));
  }

  return 100;
}

function textContainsEither(a: string, b: string): boolean {
  return normalizeText(a).includes(normalizeText(b)) || normalizeText(b).includes(normalizeText(a));
}

export function stripSeniorityWords(text: string): string {
  let result = text;
  const phrases = ["head of", "director of", "vp of", "manager of"];
  for (const phrase of phrases) {
    result = result.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
  }
  const words = ["senior", "junior", "lead", "principal", "associate", "assistant", "chief", "staff"];
  for (const word of words) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  }
  return result.replace(/\s+/g, " ").trim();
}

export function mapJobSeniorityTo10LevelRank(seniorityLevel?: string | null): number | null {
  if (!seniorityLevel) return null;
  const s = seniorityLevel.toLowerCase().trim().replace(/[\s-]/g, "_");
  if (s.includes("entry") || s.includes("intern")) return 0;
  if (s === "mid_level" || s === "mid") return 1;
  if (s === "executive") return 2;
  if (s === "senior_executive") return 3;
  if (s === "manager") return 4;
  if (s === "senior_manager") return 5;
  if (s === "agm" || s.includes("assistant_general")) return 6;
  if (s === "gm" || s.includes("general_manager")) return 7;
  if (s === "director") return 8;
  if (s === "c_suite" || s.includes("vp") || s.includes("chief")) return 9;
  return null; // "other", custom, or unmapped -> skip gate
}

export function checkSeniorityConflict(
  currentRoleRank: number | null,
  candidateSeniority6?: string | null
): boolean {
  if (currentRoleRank === null || !candidateSeniority6) return false;
  const s = candidateSeniority6.toLowerCase().trim();

  let minRank = 0;
  let maxRank = 9;

  if (s === "intern") { minRank = 0; maxRank = 0; }
  else if (s === "junior") { minRank = 0; maxRank = 1; }
  else if (s === "mid") { minRank = 1; maxRank = 2; }
  else if (s === "senior") { minRank = 3; maxRank = 4; }
  else if (s === "lead") { minRank = 4; maxRank = 5; }
  else if (s === "executive") { minRank = 6; maxRank = 9; }
  else { return false; }

  if (currentRoleRank < minRank - 1 || currentRoleRank > maxRank + 1) {
    return true;
  }
  return false;
}

export function canonicalizeRoleTitle(title: string): string {
  let s = normalizeText(title);

  // 1. Non-Software "Developer" phrases (MUST come first to prevent false SWE mapping)
  s = s.replace(/\b(business developer|business development manager|business development executive|business development|bdm)\b/g, "business_development");
  s = s.replace(/\b(property developer|real estate developer|land developer)\b/g, "real_estate");

  // 2. Specific Tech Specialties (Mobile, Fullstack, Frontend, Backend, DevOps, QA, Data)
  s = s.replace(/\b(mobile application developer|mobile app developer|mobile developer|mobile engineer|ios developer|android developer|flutter developer|react native developer)\b/g, "mobile_developer");
  s = s.replace(/\b(full\s*stack developer|full\s*stack engineer|full\s*stack software engineer|full-stack|fullstack)\b/g, "fullstack_engineer");
  s = s.replace(/\b(front\s*end developer|front\s*end engineer|front\s*end software engineer|front-end|frontend)\b/g, "frontend_engineer");
  s = s.replace(/\b(back\s*end developer|back\s*end engineer|back\s*end software engineer|back-end|backend)\b/g, "backend_engineer");
  s = s.replace(/\b(web developer|web development|web engineer)\b/g, "web_developer");
  s = s.replace(/\b(devops engineer|dev ops|devops|sre|site reliability engineer|cloud engineer|infrastructure engineer)\b/g, "devops");
  s = s.replace(/\b(qa engineer|quality assurance|sqa|software test engineer|test engineer|qa)\b/g, "qa_engineer");
  s = s.replace(/\b(data scientist|data engineer|ai engineer|machine learning engineer|ml engineer)\b/g, "data_engineer");

  // 3. General Software Engineer / Developer
  s = s.replace(/\b(software engineer|software developer|software development|programmer|coder|swe)\b/g, "software_engineer");
  
  // 4. Standalone generic "developer"
  s = s.replace(/\bdeveloper\b/g, "software_engineer");

  return s.trim();
}

function scoreTitleMatchImpl(jobTitles: string[], candidateTitleText: string): number {
  const cleanedCandidate = stripSeniorityWords(candidateTitleText);
  const candidateNorm = canonicalizeRoleTitle(cleanedCandidate);
  if (!candidateNorm) return 0;

  const candSeniorityToken = extractTitleSeniorityToken(candidateTitleText);

  let best = 0;
  for (const jobTitle of jobTitles) {
    const jobSeniorityToken = extractTitleSeniorityToken(jobTitle);
    const cleanedJob = stripSeniorityWords(jobTitle);
    const jobNorm = canonicalizeRoleTitle(cleanedJob);
    if (!jobNorm) continue;

    let baseScore = 0;
    if (candidateNorm === jobNorm) {
      baseScore = 100;
    } else if (textContainsEither(candidateNorm, jobNorm)) {
      baseScore = 95;
    } else {
      const jobTokens = titleTokens(cleanedJob);
      const candidateTokens = titleTokens(cleanedCandidate);
      if (jobTokens.length > 0 && candidateTokens.length > 0) {
        const jobTokenSet = new Set(jobTokens);
        const candidateTokenSet = new Set(candidateTokens);
        const overlap = [...jobTokenSet].filter((token) => candidateTokenSet.has(token)).length;
        if (overlap > 0) {
          const coverage = overlap / jobTokenSet.size;
          const reciprocal = overlap / candidateTokenSet.size;
          const blended = (coverage * 0.7) + (reciprocal * 0.3);
          baseScore = Math.round(blended * 90);
        } else {
          baseScore = 0;
        }
      }
    }

    // Fix title-stripping overlap bug: if candidate and job titles explicitly specify conflicting seniority levels, apply adjustment factor
    if (jobSeniorityToken && candSeniorityToken && jobSeniorityToken !== candSeniorityToken && baseScore > 0) {
      const jRank = seniorityRank(jobSeniorityToken);
      const cRank = seniorityRank(candSeniorityToken);
      if (jRank >= 0 && cRank >= 0 && cRank > jRank) {
        baseScore = Math.round(baseScore * 0.70);
      }
    }

    best = Math.max(best, baseScore);
  }

  return best;
}

function skillMatches(requiredSkill: string, candidateSkills: string[]): string | null {
  // Normalize through synonym map first (e.g. "tea auction" → "Tea Trading", "mysql" → "SQL")
  const requiredNormalized = normaliseSkill(requiredSkill);
  const requiredNorm = normalizeSkillForComparison(requiredNormalized);
  if (!requiredNorm) return null;

  const requiredDomain = getSkillDomain(requiredSkill);
  const MIN_SUBSTRING_LEN = 3;

  for (const candidateSkill of candidateSkills) {
    const candidateNormalized = normaliseSkill(candidateSkill);
    const candidateNorm = normalizeSkillForComparison(candidateNormalized);
    if (!candidateNorm) continue;

    // Exact match always wins
    if (candidateNorm === requiredNorm) return candidateSkill;

    // Domain gate: if both skills have known domains and they differ, skip
    // This prevents "C" (programming) from matching "Contract Negotiation" (business)
    const candidateDomain = getSkillDomain(candidateSkill);
    if (requiredDomain !== "unknown" && candidateDomain !== "unknown" && requiredDomain !== candidateDomain) {
      continue;
    }

    // Substring match: only allowed when BOTH strings are >= MIN_SUBSTRING_LEN characters
    if (requiredNorm.length >= MIN_SUBSTRING_LEN && candidateNorm.length >= MIN_SUBSTRING_LEN) {
      if (candidateNorm.includes(requiredNorm) || requiredNorm.includes(candidateNorm)) return candidateSkill;
    }

    const requiredTokens = skillTokens(requiredNorm);
    const candidateTokens = skillTokens(candidateNorm);
    if (requiredTokens.length === 0 || candidateTokens.length === 0) continue;

    // Token overlap: only use tokens that are >= MIN_SUBSTRING_LEN to avoid noise from short tokens
    const requiredSet = new Set(requiredTokens.filter((t) => t.length >= MIN_SUBSTRING_LEN));
    const candidateSet = new Set(candidateTokens.filter((t) => t.length >= MIN_SUBSTRING_LEN));
    if (requiredSet.size === 0 || candidateSet.size === 0) continue;

    const overlap = [...requiredSet].filter((token) => candidateSet.has(token)).length;
    const score = overlap / Math.max(requiredSet.size, candidateSet.size);
    if (score >= 0.6) return candidateSkill;
  }

  return null;
}

export function scoreSkills(requiredSkills: string[], preferredSkills: string[], candidateSkills: string[]) {
  const matchedRequired: string[] = [];
  const missingRequired: string[] = [];
  const matchedPreferred: string[] = [];

  // Deduplicate by normalized value to avoid counting same candidate skill multiple times
  const GENERIC_FILLER_SKILLS = new Set([
    "engineering team", "team", "environment", "development", "full-stack", "full stack",
    "software engineer", "skilled", "candidate", "role", "requirements", "experience",
    "collaborative", "collaborative environment"
  ]);

  const cleanRequired = distinct(requiredSkills).filter(s => !GENERIC_FILLER_SKILLS.has(s.toLowerCase().trim()));
  const cleanPreferred = distinct(preferredSkills).filter(s => !GENERIC_FILLER_SKILLS.has(s.toLowerCase().trim()));

  const matchedNormalizedSet = new Set<string>();

  for (const skill of cleanRequired) {
    const match = skillMatches(skill, candidateSkills);
    if (match) {
      const matchNorm = normalizeSkillForComparison(match);
      if (!matchedNormalizedSet.has(matchNorm)) {
        matchedRequired.push(match);
        matchedNormalizedSet.add(matchNorm);
      } else {
        missingRequired.push(skill);
      }
    } else {
      missingRequired.push(skill);
    }
  }

  for (const skill of cleanPreferred) {
    const match = skillMatches(skill, candidateSkills);
    if (match) matchedPreferred.push(match);
  }

  const requiredCount = cleanRequired.length;
  const preferredCount = cleanPreferred.length;
  if (requiredCount === 0 && preferredCount === 0) {
    return {
      score: 75,
      matchedRequired,
      missingRequired,
      matchedPreferred,
    };
  }
  const requiredCoverage = requiredCount === 0 ? 1 : matchedRequired.length / requiredCount;
  const preferredCoverage = preferredCount === 0 ? 0 : matchedPreferred.length / preferredCount;

  // If candidate matched 2+ core tech skills or >= 50% coverage, award generous tech competence score
  let baseTechScore = (requiredCoverage * 80) + (preferredCoverage * 20);
  if (matchedRequired.length >= 2) {
    baseTechScore = Math.max(baseTechScore, 75);
  }
  if (matchedRequired.length >= 3) {
    baseTechScore = Math.max(baseTechScore, 90);
  }

  const score = Math.round(Math.min(100, baseTechScore));

  return {
    score,
    matchedRequired,
    missingRequired,
    matchedPreferred,
  };
}

function scoreIndustry(jobIndustry: string | null, candidateIndustries?: string[] | null): number {
  if (!jobIndustry) return 100;
  if (!candidateIndustries || candidateIndustries.length === 0) return 60;
  const jobNorm = normalizeText(jobIndustry);
  const matched = candidateIndustries.some(
    (ind) => normalizeText(ind) === jobNorm || normalizeText(ind).includes(jobNorm) || jobNorm.includes(normalizeText(ind))
  );
  return matched ? 100 : 45;
}

// Canonical City to Country & Region Mapping
const GEOGRAPHIC_CITY_TO_COUNTRY_MAP: Record<string, string> = {
  // Sri Lanka
  colombo: "sri lanka",
  kandy: "sri lanka",
  galle: "sri lanka",
  jaffna: "sri lanka",
  negombo: "sri lanka",
  kurunegala: "sri lanka",
  dehiwala: "sri lanka",
  moratuwa: "sri lanka",
  gampaha: "sri lanka",
  katunayake: "sri lanka",
  batticaloa: "sri lanka",
  trincomalee: "sri lanka",
  matara: "sri lanka",
  anuradhapura: "sri lanka",
  ratnapura: "sri lanka",
  badulla: "sri lanka",
  "nuwara eliya": "sri lanka",
  hambantota: "sri lanka",
  kalutara: "sri lanka",
  kotte: "sri lanka",
  "mount lavinia": "sri lanka",
  "sri lanka": "sri lanka",
  lanka: "sri lanka",
  "western province": "sri lanka",
  "central province": "sri lanka",
  "southern province": "sri lanka",

  // United Arab Emirates (UAE)
  dubai: "united arab emirates",
  "abu dhabi": "united arab emirates",
  sharjah: "united arab emirates",
  ajman: "united arab emirates",
  "ras al khaimah": "united arab emirates",
  fujairah: "united arab emirates",
  "al ain": "united arab emirates",
  uae: "united arab emirates",
  "united arab emirates": "united arab emirates",

  // Saudi Arabia (KSA)
  riyadh: "saudi arabia",
  jeddah: "saudi arabia",
  dammam: "saudi arabia",
  khobar: "saudi arabia",
  mecca: "saudi arabia",
  medina: "saudi arabia",
  jubail: "saudi arabia",
  ksa: "saudi arabia",
  "saudi arabia": "saudi arabia",

  // Qatar
  doha: "qatar",
  "al rayyan": "qatar",
  "al wakrah": "qatar",
  qatar: "qatar",

  // Singapore
  singapore: "singapore",

  // Malaysia
  "kuala lumpur": "malaysia",
  penang: "malaysia",
  "johor bahru": "malaysia",
  malaysia: "malaysia",

  // Australia
  sydney: "australia",
  melbourne: "australia",
  brisbane: "australia",
  perth: "australia",
  adelaide: "australia",
  australia: "australia",

  // United Kingdom / UK
  london: "united kingdom",
  manchester: "united kingdom",
  birmingham: "united kingdom",
  uk: "united kingdom",
  "united kingdom": "united kingdom",
  england: "united kingdom",
  scotland: "united kingdom",

  // Canada
  toronto: "canada",
  vancouver: "canada",
  montreal: "canada",
  canada: "canada",

  // USA
  "new york": "united states",
  "san francisco": "united states",
  chicago: "united states",
  austin: "united states",
  usa: "united states",
  "united states": "united states",
};

export interface LocationEvaluationResult {
  score: number;
  status: "match" | "region_match" | "different" | "not specified";
  gate: "pass" | "region_pass" | "unspecified_pass" | "remote_pass" | "excluded_mismatch";
  penalty: number;
}

export function evaluateLocationMatch(
  jobLocationStr: string | null | undefined,
  candLocationStr?: string | null,
  strictLocation?: boolean
): LocationEvaluationResult {
  const normJob = normalizeText(jobLocationStr || "");
  const normCand = normalizeText(candLocationStr || "");

  // 1. Remote / Unspecified Job Location
  if (!normJob || normJob.includes("remote") || normJob.includes("anywhere") || normJob.includes("work from home")) {
    return { score: 100, status: "match", gate: "remote_pass", penalty: 0 };
  }

  // 2. Unspecified Candidate Location
  if (!normCand) {
    return strictLocation
      ? { score: 30, status: "different", gate: "excluded_mismatch", penalty: -25 }
      : { score: 60, status: "not specified", gate: "unspecified_pass", penalty: 0 };
  }

  // 3. Direct String Identity / Substring Match
  if (normCand === normJob || normCand.includes(normJob) || normJob.includes(normCand)) {
    return { score: 100, status: "match", gate: "pass", penalty: 0 };
  }

  // Colombo Metro alias check
  const colomboMetro = ["colombo", "dehiwala", "moratuwa", "mount lavinia", "nugegoda", "battaramulla", "rajagiriya", "kotte", "maharagama", "malabe"];
  const isJobColombo = colomboMetro.some(c => normJob.includes(c));
  const isCandColombo = colomboMetro.some(c => normCand.includes(c));
  if (isJobColombo && isCandColombo) {
    return { score: 100, status: "match", gate: "pass", penalty: 0 };
  }

  // If strict location requested and candidate is outside target city (e.g. Kegalle vs Colombo)
  if (strictLocation) {
    return { score: 0, status: "different", gate: "excluded_mismatch", penalty: -40 };
  }

  // 4. Token & Geographic Knowledge Resolution
  const jobTokens = tokenize(normJob);
  const candTokens = tokenize(normCand);

  let jobCountry: string | null = null;
  let candCountry: string | null = null;

  for (const token of jobTokens) {
    if (GEOGRAPHIC_CITY_TO_COUNTRY_MAP[token]) {
      jobCountry = GEOGRAPHIC_CITY_TO_COUNTRY_MAP[token];
      break;
    }
  }
  if (!jobCountry) {
    for (const [key, country] of Object.entries(GEOGRAPHIC_CITY_TO_COUNTRY_MAP)) {
      if (normJob.includes(key)) {
        jobCountry = country;
        break;
      }
    }
  }

  for (const token of candTokens) {
    if (GEOGRAPHIC_CITY_TO_COUNTRY_MAP[token]) {
      candCountry = GEOGRAPHIC_CITY_TO_COUNTRY_MAP[token];
      break;
    }
  }
  if (!candCountry) {
    for (const [key, country] of Object.entries(GEOGRAPHIC_CITY_TO_COUNTRY_MAP)) {
      if (normCand.includes(key)) {
        candCountry = country;
        break;
      }
    }
  }

  // Bi-Directional Country Match (e.g. Cand "Colombo" -> Sri Lanka vs Job "Sri Lanka" -> Sri Lanka)
  if (jobCountry && candCountry && jobCountry === candCountry) {
    const isJobCountryOnly = normJob === jobCountry || normJob === "lanka";
    const isCandCountryOnly = normCand === candCountry || normCand === "lanka";

    if (isJobCountryOnly || isCandCountryOnly) {
      return { score: 100, status: "match", gate: "pass", penalty: 0 };
    }

    // Both specified different cities in the same country (e.g. "Colombo" vs "Kandy" or "Kegalle")
    return { score: 85, status: "region_match", gate: "region_pass", penalty: 0 };
  }

  // Token Overlap check for sub-regions/districts
  const jobSet = new Set(jobTokens);
  const candSet = new Set(candTokens);
  const overlap = [...jobSet].filter((t) => candSet.has(t)).length;
  if (overlap > 0) {
    return { score: 85, status: "region_match", gate: "region_pass", penalty: 0 };
  }

  // If both countries are identified and explicitly different (e.g. Sri Lanka vs UAE)
  if (jobCountry && candCountry && jobCountry !== candCountry) {
    return { score: 0, status: "different", gate: "excluded_mismatch", penalty: -30 };
  }

  // Fallback explicit mismatch
  return { score: 0, status: "different", gate: "excluded_mismatch", penalty: -30 };
}

function scoreLocation(jobLocation: string | null, candidateLocation?: string | null): number {
  return evaluateLocationMatch(jobLocation, candidateLocation).score;
}

function buildCandidateTitleText(cv: {
  currentTitle?: string;
  summary?: string;
  fullName?: string;
  rawText?: string;
}): string {
  return [
    cv.currentTitle,
    cv.summary?.slice(0, 160),
    cv.fullName,
    cv.rawText?.slice(0, 240),
  ].filter(Boolean).join(" ");
}

export type ScoredCandidate = {
  index: number;
  cv: {
    _id: string;
    fullName?: string;
    currentTitle?: string;
    currentEmployer?: string;
    industries?: string[];
    seniorityLevel?: string;
    yearsOfExperience?: number;
    location?: string;
    skills?: string[];
    rawText?: string;
    summary?: string;
    vectorScore?: number;
  };
  titleScore: number;
  seniorityScore: number;
  experienceScore: number;
  skillScore: number;
  industryScore: number;
  locationScore: number;
  overallScore: number;
  locationStatus: "match" | "region_match" | "different" | "not specified";
  locationGate?: string;
  locationPenalty?: number;
  matchedRequired: string[];
  missingRequired: string[];
  matchedPreferred: string[];
  reason: string;
  llmScore?: { score: number; reason: string };
};

const skillSynonyms: Record<string, string[]> = {
  // ── Programming Languages ──
  JavaScript: ["js", "javascript", "node", "nodejs"],
  Python: ["python3", "python2", "py"],
  "C#": ["c sharp", "csharp"],
  "C++": ["c++", "cpp"],
  TypeScript: ["ts", "typescript", "type script"],
  Java: ["java", "j2ee", "jee"],
  Go: ["go", "golang"],
  PHP: ["php", "laravel", "symfony"],
  Ruby: ["ruby", "rails", "ror"],
  Swift: ["swift", "swiftui", "swift ios"],
  Kotlin: ["kotlin", "kotlin android"],
  Scala: ["scala"],
  R: ["r programming", "r studio"],
  Rust: ["rust", "rustlang"],
  Perl: ["perl"],
  "C": ["c programming", "ansi c", "embedded c"],

  // ── Frameworks & Libraries ──
  React: ["reactjs", "react.js", "react native"],
  Vue: ["vue", "vuejs", "vue.js"],
  Angular: ["angular", "angularjs", "angular.js"],
  "Node.js": ["nodejs", "node js", "express", "expressjs"],
  NextJS: ["next js", "next.js", "nextjs"],
  Django: ["django", "django rest framework", "drf"],
  Laravel: ["laravel"],
  Spring: ["spring", "spring boot", "springboot"],
  Flutter: ["flutter", "flutter dart"],
  "React Native": ["react native", "react-native"],

  // ── Data & Databases ──
  SQL: ["mysql", "postgresql", "postgres", "mssql", "sql server", "mariadb", "sqlite"],
  NoSQL: ["mongodb", "mongo", "nosql", "redis", "elasticsearch", "cassandra", "dynamodb"],
  Excel: ["ms excel", "microsoft excel", "spreadsheets", "google sheets"],
  "Power BI": ["powerbi", "power-bi", "microsoft power bi"],
  Tableau: ["tableau", "tableau desktop"],
  "Data Analysis": ["analytics", "data analytics", "data analysis", "business intelligence", "bi"],
  "Machine Learning": ["ml", "machine learning", "deep learning", "artificial intelligence", "ai", "nlp", "natural language processing"],
  "Data Science": ["data science", "data scientist", "data engineering"],
  Pandas: ["pandas", "data manipulation"],
  TensorFlow: ["tensorflow", "keras"],
  PyTorch: ["pytorch", "torch"],

  // ── Cloud & Infrastructure ──
  AWS: ["amazon web services", "amazon aws", "ec2", "s3", "lambda"],
  Azure: ["microsoft azure", "ms azure", "azure devops"],
  GCP: ["google cloud platform", "google cloud", "gcloud"],
  Docker: ["docker", "container", "containers", "containerization"],
  Kubernetes: ["k8s", "kubernetes"],
  DevOps: ["devops", "ci/cd", "cicd", "pipelines", "jenkins", "gitlab ci"],
  Git: ["git", "github", "gitlab", "bitbucket"],
  Linux: ["linux", "ubuntu", "centos", "redhat", "unix"],
  Terraform: ["terraform", "infrastructure as code", "iac"],
  "CI/CD": ["ci/cd", "cicd", "continuous integration", "continuous deployment", "jenkins", "github actions"],

  // ── Frontend & Design ──
  HTML: ["html", "html5"],
  CSS: ["css", "css3", "sass", "scss", "less", "tailwind", "tailwindcss"],
  "UI/UX": ["ux design", "ui design", "user experience", "user interface", "figma", "sketch", "adobe xd"],
  Figma: ["figma", "figma design", "figma prototyping"],
  "Web Design": ["web design", "responsive design", "mobile first"],

  // ── Business & Trade ──
  Negotiation: ["negotiation", "contract negotiation", "pricing negotiation", "deal negotiation", "commercial negotiation"],
  Sales: ["sales", "tea sales", "international sales", "business sales", "b2b sales", "b2c sales", "field sales", "inside sales", "revenue generation"],
  "Business Development": ["business development", "new business", "client acquisition", "market development", "partnership development", "biz dev"],
  "Account Management": ["account management", "key account management", "client management", "relationship management"],
  "Customer Relationship": ["crm", "customer relationship", "customer relationship management", "client retention"],
  Marketing: ["marketing", "digital marketing", "content marketing", "social media marketing", "seo", "sem", "ppc", "brand management"],
  "Market Research": ["market research", "market analysis", "market trends", "competitive analysis", "competitor analysis"],
  Finance: ["finance", "financial analysis", "accounting", "budgeting", "forecasting", "p&l", "profit and loss"],
  "Financial Modeling": ["financial modeling", "financial model", "valuation", "dcf"],
  "Risk Management": ["risk management", "risk assessment", "compliance", "regulatory"],
  Strategy: ["strategy", "strategic planning", "corporate strategy", "business strategy"],
  Consulting: ["consulting", "management consulting", "business consulting", "advisory"],
  "Project Management": ["project manager", "project management", "pmp", "agile", "scrum", "kanban", "waterfall", "prince2"],
  "Product Management": ["product management", "product owner", "product strategy", "roadmap management"],
  Operations: ["operations", "operations management", "process improvement", "lean", "six sigma"],
  "Quality Assurance": ["qa", "quality assurance", "quality control", "iso", "iso 9001", "six sigma"],
  HR: ["hr", "human resources", "recruitment", "talent acquisition", "people operations", "compensation and benefits"],
  Admin: ["admin", "administration", "office management", "facilities management"],
  Legal: ["legal", "law", "compliance", "contract law", "corporate law", "regulatory affairs"],

  // ── Trade & Supply Chain ──
  "Tea Trading": ["tea trading", "tea auction", "tea brokering", "tea market", "tea commerce"],
  "Tea Grading": ["tea grading", "tea tasting", "tea evaluation", "tea characteristics"],
  Export: ["export", "tea export", "export documentation", "export trade", "exports", "international export"],
  Import: ["import", "import documentation", "import trade", "imports"],
  "International Trade": ["international trade", "global trade", "cross-border trade", "foreign trade", "overseas trade"],
  "Supply Chain": ["supply chain", "supply chain management", "scm"],
  Logistics: ["logistics", "freight", "shipping", "shipment", "warehousing", "distribution", "3pl", "last mile delivery"],
  Procurement: ["procurement", "purchasing", "sourcing", "vendor management", "supplier management", "vendor relations"],
  "Inventory Management": ["inventory management", "stock management", "warehouse management", "wms"],
  "Customs Clearance": ["customs", "customs clearance", "customs documentation", "incoterms", "hs code"],
  "Trade Compliance": ["trade compliance", "export compliance", "sanctions", "embargo"],

  // ── Soft Skills ──
  Communication: ["communication", "interpersonal skills", "presentation skills", "verbal communication", "written communication", "public speaking"],
  Leadership: ["leadership", "team lead", "team leadership", "people management", "people leadership", "management"],
  "Team Management": ["team management", "team building", "team coordination", "cross-functional team"],
  "Problem Solving": ["problem solving", "analytical thinking", "critical thinking", "troubleshooting"],
  "Time Management": ["time management", "prioritization", "multitasking"],
  "Adaptability": ["adaptability", "flexibility", "agility", "resilience"],
  "Attention to Detail": ["attention to detail", "detail oriented", "meticulous"],
  "Stakeholder Management": ["stakeholder management", "stakeholder engagement", "executive communication"],
  "Networking": ["networking", "relationship building", "professional networking"],
  "Presentation": ["presentation", "public speaking", "pitching", "storytelling"],
  "Conflict Resolution": ["conflict resolution", "conflict management", "mediation"],
  "Decision Making": ["decision making", "strategic decision", "data driven decisions"],
  "Creativity": ["creativity", "creative thinking", "innovation", "design thinking"],
  "Work Ethic": ["work ethic", "self motivation", "initiative", "proactivity"],
  "Emotional Intelligence": ["emotional intelligence", "eq", "empathy", "self awareness"],

  // ── Industry / Domain ──
  Banking: ["banking", "retail banking", "corporate banking", "investment banking", "wholesale banking"],
  Insurance: ["insurance", "underwriting", "claims", "actuarial"],
  Telecom: ["telecom", "telecommunications", "network engineering"],
  Healthcare: ["healthcare", "medical", "clinical", "pharma", "pharmaceutical", "biotech"],
  Education: ["education", "teaching", "training", "curriculum development", "instructional design"],
  RealEstate: ["real estate", "property management", "realty", "property valuation"],
  Manufacturing: ["manufacturing", "production", "assembly", "lean manufacturing", "plc", "scada"],
  Construction: ["construction", "civil engineering", "project execution", "site management"],
  Energy: ["energy", "oil and gas", "renewable energy", "solar", "power generation"],
  "FMCG": ["fmcg", "fast moving consumer goods", "consumer goods", "retail", "distribution"],
  Hospitality: ["hospitality", "hotel management", "f&b", "food and beverage", "tourism"],
  Aviation: ["aviation", "airline", "aircraft", "flight operations", "airport"],
  Shipping: ["shipping", "marine", "maritime", "vessel", "port operations"],
  Agriculture: ["agriculture", "farming", "agronomy", "plantation", "horticulture"],
  "Plantation": ["plantation", "estate management", "crop management", "tea estate", "rubber estate"],
};

// ── Skill Domain Taxonomy ──────────────────────────────────────────────────
// Maps normalized skill names to their domain. Used by skillMatches() to
// prevent cross-domain false positives (e.g. "C" programming matching
// "Contract Negotiation" via substring).
const SKILL_DOMAINS: Record<string, string> = {
  // Programming Languages
  "c": "programming", "c++": "programming", "c#": "programming",
  "java": "programming", "python": "programming", "javascript": "programming",
  "typescript": "programming", "php": "programming", "ruby": "programming",
  "go": "programming", "golang": "programming", "rust": "programming",
  "swift": "programming", "kotlin": "programming", "scala": "programming",
  "r": "programming", "perl": "programming", "objective c": "programming",
  "vb": "programming", "vba": "programming", "matlab": "programming",
  "sql": "programming", "plsql": "programming", "t sql": "programming",

  // Frameworks & Libraries
  "react": "framework", "reactjs": "framework", "react.js": "framework",
  "react native": "framework", "angular": "framework", "angularjs": "framework",
  "vue": "framework", "vuejs": "framework", "vue.js": "framework",
  "nodejs": "framework", "node.js": "framework", "express": "framework",
  "nextjs": "framework", "next.js": "framework", "nuxt": "framework",
  "django": "framework", "flask": "framework", "fastapi": "framework",
  "spring": "framework", "spring boot": "framework", "springboot": "framework",
  "laravel": "framework", "symfony": "framework", "codeigniter": "framework",
  "ruby on rails": "framework", "rails": "framework",
  "flutter": "framework", "dart": "framework",
  "swiftui": "framework", "uikit": "framework",
  "tensorflow": "framework", "keras": "framework", "pytorch": "framework",
  "pandas": "framework", "numpy": "framework", "scipy": "framework",
  "spark": "framework", "hadoop": "framework", "kafka": "framework",

  // Data & Analytics
  "mysql": "data", "postgresql": "data", "postgres": "data",
  "mssql": "data", "sql server": "data", "mariadb": "data",
  "sqlite": "data", "oracle db": "data", "oracle database": "data",
  "mongodb": "data", "mongo": "data", "redis": "data",
  "elasticsearch": "data", "cassandra": "data", "dynamodb": "data",
  "nosql": "data", "couchdb": "data", "neo4j": "data",
  "excel": "data", "microsoft excel": "data", "ms excel": "data",
  "google sheets": "data", "spreadsheets": "data",
  "powerbi": "data", "power bi": "data", "tableau": "data",
  "looker": "data", "qlik": "data", "google data studio": "data",
  "data analysis": "data", "analytics": "data", "business intelligence": "data",
  "bi": "data", "data warehousing": "data", "etl": "data",
  "data science": "data", "machine learning": "data", "deep learning": "data",
  "artificial intelligence": "data", "ai": "data", "nlp": "data",
  "natural language processing": "data", "computer vision": "data",

  // Cloud & Infrastructure
  "aws": "infrastructure", "amazon web services": "infrastructure",
  "azure": "infrastructure", "microsoft azure": "infrastructure",
  "gcp": "infrastructure", "google cloud": "infrastructure",
  "docker": "infrastructure", "kubernetes": "infrastructure", "k8s": "infrastructure",
  "jenkins": "infrastructure", "gitlab ci": "infrastructure", "github actions": "infrastructure",
  "terraform": "infrastructure", "ansible": "infrastructure", "puppet": "infrastructure",
  "git": "infrastructure", "github": "infrastructure", "gitlab": "infrastructure",
  "bitbucket": "infrastructure", "svn": "infrastructure",
  "linux": "infrastructure", "ubuntu": "infrastructure", "centos": "infrastructure",
  "redhat": "infrastructure", "unix": "infrastructure", "windows server": "infrastructure",
  "nginx": "infrastructure", "apache": "infrastructure", "iis": "infrastructure",
  "ci/cd": "infrastructure", "cicd": "infrastructure", "devops": "infrastructure",
  "maven": "infrastructure", "gradle": "infrastructure", "npm": "infrastructure",

  // Frontend & Design
  "html": "design", "html5": "design",
  "css": "design", "css3": "design", "sass": "design", "scss": "design",
  "less": "design", "tailwind": "design", "tailwindcss": "design", "bootstrap": "design",
  "figma": "design", "sketch": "design", "adobe xd": "design", "zeplin": "design",
  "ux design": "design", "ui design": "design", "user experience": "design",
  "user interface": "design", "web design": "design", "responsive design": "design",
  "photoshop": "design", "illustrator": "design", "indesign": "design",
  "after effects": "design", "premiere pro": "design",

  // QA & Testing
  "selenium": "qa", "cypress": "qa", "playwright": "qa", "puppeteer": "qa",
  "jest": "qa", "mocha": "qa", "chai": "qa", "junit": "qa", "testng": "qa",
  "jmeter": "qa", "postman": "qa", "soapui": "qa",
  "manual testing": "qa", "automation testing": "qa", "performance testing": "qa",
  "load testing": "qa", "security testing": "qa", "penetration testing": "qa",
  "uat": "qa", "regression testing": "qa", "smoke testing": "qa",
  "quality assurance": "qa", "quality control": "qa", "test automation": "qa",

  // Business & Commercial
  "negotiation": "business", "contract negotiation": "business",
  "pricing negotiation": "business", "deal negotiation": "business",
  "commercial negotiation": "business",
  "sales": "business", "b2b sales": "business", "b2c sales": "business",
  "field sales": "business", "inside sales": "business", "key account sales": "business",
  "international sales": "business", "tea sales": "business",
  "business development": "business", "new business": "business",
  "client acquisition": "business", "market development": "business",
  "partnership development": "business", "biz dev": "business",
  "account management": "business", "key account management": "business",
  "client management": "business", "relationship management": "business",
  "customer relationship": "business", "crm": "business",
  "customer relationship management": "business", "client retention": "business",
  "revenue generation": "business", "target achievement": "business",
  "kpi": "business", "okr": "business",
  "marketing": "business", "digital marketing": "business",
  "content marketing": "business", "social media marketing": "business",
  "seo": "business", "sem": "business", "ppc": "business",
  "brand management": "business", "product marketing": "business",
  "market research": "business", "market analysis": "business",
  "market trends": "business", "competitive analysis": "business",
  "competitor analysis": "business", "swot analysis": "business",
  "pricing": "business", "commercial": "business",
  "commercial acumen": "business", "business acumen": "business",
  "strategy": "business", "strategic planning": "business",
  "business strategy": "business", "corporate strategy": "business",
  "consulting": "business", "management consulting": "business",
  "business consulting": "business", "advisory": "business",
  "finance": "business", "financial analysis": "business",
  "accounting": "business", "budgeting": "business", "forecasting": "business",
  "p&l": "business", "profit and loss": "business",
  "financial modeling": "business", "valuation": "business", "dcf": "business",
  "risk management": "business", "risk assessment": "business",
  "compliance": "business", "regulatory": "business",
  "legal": "business", "law": "business", "contract law": "business",
  "corporate law": "business", "regulatory affairs": "business",

  // Trade & Supply Chain
  "tea trading": "trade", "tea auction": "trade", "tea brokering": "trade",
  "tea market": "trade", "tea commerce": "trade",
  "tea grading": "trade", "tea tasting": "trade", "tea evaluation": "trade",
  "tea characteristics": "trade",
  "export": "trade", "tea export": "trade", "export documentation": "trade",
  "export trade": "trade", "exports": "trade", "international export": "trade",
  "import": "trade", "import documentation": "trade", "import trade": "trade",
  "international trade": "trade", "global trade": "trade",
  "cross-border trade": "trade", "foreign trade": "trade", "overseas trade": "trade",
  "supply chain": "trade", "supply chain management": "trade", "scm": "trade",
  "logistics": "trade", "freight": "trade", "shipping": "trade",
  "shipment": "trade", "warehousing": "trade", "distribution": "trade",
  "3pl": "trade", "last mile delivery": "trade",
  "procurement": "trade", "purchasing": "trade", "sourcing": "trade",
  "vendor management": "trade", "supplier management": "trade", "vendor relations": "trade",
  "inventory management": "trade", "stock management": "trade",
  "warehouse management": "trade", "wms": "trade",
  "customs": "trade", "customs clearance": "trade", "customs documentation": "trade",
  "incoterms": "trade", "hs code": "trade",
  "trade compliance": "trade", "export compliance": "trade",
  "sanctions": "trade", "embargo": "trade",
  "trade fairs": "trade", "trade exhibitions": "trade", "exhibitions": "trade",

  // Operations & Management
  "project management": "operations", "pmp": "operations", "prince2": "operations",
  "agile": "operations", "scrum": "operations", "kanban": "operations",
  "waterfall": "operations", "lean": "operations", "six sigma": "operations",
  "process improvement": "operations", "kaizen": "operations",
  "product management": "operations", "product owner": "operations",
  "product strategy": "operations", "roadmap management": "operations",
  "operations": "operations", "operations management": "operations",
  "business process": "operations", "workflow optimization": "operations",
  "iso": "operations", "iso 9001": "operations", "iso 14001": "operations",
  "change management": "operations", "continuous improvement": "operations",

  // HR & People
  "hr": "people", "human resources": "people", "recruitment": "people",
  "talent acquisition": "people", "people operations": "people",
  "compensation and benefits": "people", "c&b": "people",
  "employee engagement": "people", "learning and development": "people",
  "l&d": "people", "training and development": "people",
  "performance management": "people", "employee relations": "people",
  "organizational development": "people", "od": "people",
  "workforce planning": "people", "succession planning": "people",
  "diversity and inclusion": "people", "d&i": "people",

  // Soft Skills
  "communication": "soft_skills", "interpersonal skills": "soft_skills",
  "presentation skills": "soft_skills", "verbal communication": "soft_skills",
  "written communication": "soft_skills", "public speaking": "soft_skills",
  "leadership": "soft_skills", "team lead": "soft_skills",
  "team leadership": "soft_skills", "people management": "soft_skills",
  "people leadership": "soft_skills", "management": "soft_skills",
  "team management": "soft_skills", "team building": "soft_skills",
  "team coordination": "soft_skills", "cross-functional team": "soft_skills",
  "problem solving": "soft_skills", "analytical thinking": "soft_skills",
  "critical thinking": "soft_skills", "troubleshooting": "soft_skills",
  "time management": "soft_skills", "prioritization": "soft_skills",
  "multitasking": "soft_skills",
  "adaptability": "soft_skills", "flexibility": "soft_skills",
  "resilience": "soft_skills",
  "attention to detail": "soft_skills", "detail oriented": "soft_skills",
  "meticulous": "soft_skills",
  "stakeholder management": "soft_skills", "stakeholder engagement": "soft_skills",
  "executive communication": "soft_skills",
  "networking": "soft_skills", "relationship building": "soft_skills",
  "professional networking": "soft_skills",
  "presentation": "soft_skills", "pitching": "soft_skills", "storytelling": "soft_skills",
  "conflict resolution": "soft_skills", "conflict management": "soft_skills",
  "mediation": "soft_skills",
  "decision making": "soft_skills", "strategic decision": "soft_skills",
  "data driven decisions": "soft_skills",
  "creativity": "soft_skills", "creative thinking": "soft_skills",
  "innovation": "soft_skills", "design thinking": "soft_skills",
  "work ethic": "soft_skills", "self motivation": "soft_skills",
  "initiative": "soft_skills", "proactivity": "soft_skills",
  "emotional intelligence": "soft_skills", "eq": "soft_skills",
  "empathy": "soft_skills", "self awareness": "soft_skills",

  // Industry / Domain Specializations
  "banking": "industry", "retail banking": "industry", "corporate banking": "industry",
  "investment banking": "industry", "wholesale banking": "industry",
  "insurance": "industry", "underwriting": "industry", "actuarial": "industry",
  "telecom": "industry", "telecommunications": "industry",
  "healthcare": "industry", "medical": "industry", "clinical": "industry",
  "pharma": "industry", "pharmaceutical": "industry", "biotech": "industry",
  "education": "industry", "teaching": "industry", "training": "industry",
  "curriculum development": "industry", "instructional design": "industry",
  "real estate": "industry", "property management": "industry",
  "manufacturing": "industry", "production": "industry", "assembly": "industry",
  "lean manufacturing": "industry", "plc": "industry", "scada": "industry",
  "construction": "industry", "civil engineering": "industry",
  "energy": "industry", "oil and gas": "industry", "renewable energy": "industry",
  "solar": "industry", "power generation": "industry",
  "fmcg": "industry", "fast moving consumer goods": "industry",
  "consumer goods": "industry", "retail": "industry",
  "hospitality": "industry", "hotel management": "industry",
  "f&b": "industry", "food and beverage": "industry", "tourism": "industry",
  "aviation": "industry", "airline": "industry", "aircraft": "industry",
  "marine": "industry", "maritime": "industry",
  "agriculture": "industry", "farming": "industry", "agronomy": "industry",
  "plantation": "industry", "tea estate": "industry", "rubber estate": "industry",
  "estate management": "industry", "crop management": "industry",
  "automotive": "industry", "defence": "industry", "mining": "industry",
};

export function getSkillDomain(skill: string): string {
  const canonical = normaliseSkill(skill);
  const norm = normalizeSkillForComparison(skill);
  const rawLower = skill.toLowerCase().trim();
  const canonicalLower = canonical.toLowerCase().trim();
  return SKILL_DOMAINS[norm] ?? SKILL_DOMAINS[rawLower] ?? SKILL_DOMAINS[canonicalLower] ?? "unknown";
}

export function normaliseSkill(skill: string): string {
  const lower = skill.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(skillSynonyms)) {
    if (lower === canonical.toLowerCase()) return canonical;
    for (const alias of aliases) {
      if (lower === alias.toLowerCase()) return canonical;
    }
  }
  return skill;
}

export function scoreCandidateAgainstRequirements(
  cv: ScoredCandidate["cv"],
  req: SearchRequirements & {
    maxYearsExperience?: number | null;
    negativeKeywords?: string[];
    overrideSeniority?: string | null;
    overrideLocation?: string | null;
    strictLocation?: boolean;
    domainPreference?: string | null;
    companyTypePreference?: string | null;
    requiredCertifications?: string[];
    currentRolePenalty?: number;
    roleFamilyMatch?: "exact" | "synonym" | "adjacent" | "unrelated";
  },
  index: number
): ScoredCandidate {
  const candidateTitleText = buildCandidateTitleText(cv);
  const candidateSkills = distinct((cv.skills ?? []).map(normaliseSkill));
  const requiredSkills = (req.requiredSkills ?? []).map(normaliseSkill);
  const preferredSkills = (req.preferredSkills ?? req.niceToHaveSkills ?? []).map(normaliseSkill);
  const jobTitleVariants = distinct([req.title, ...(req.alternativeTitles ?? [])]);
  const candidateSeniority = cv.seniorityLevel ?? inferSeniorityFromText(candidateTitleText);
  const jobSeniority = req.overrideSeniority ?? req.seniority ?? inferSeniorityFromText(`${req.title} ${req.summary}`);

  // Auto-infer maxYearsExperience for intern / entry-level roles if not specified
  let effectiveMaxYears = req.maxYearsExperience ?? null;
  const normalizedJobSeniority = (jobSeniority ?? "").toLowerCase();
  if (
    effectiveMaxYears == null &&
    (normalizedJobSeniority === "intern" || normalizedJobSeniority === "entry_level" || req.title?.toLowerCase().includes("intern"))
  ) {
    effectiveMaxYears = 1.5;
  }

  // Title Match Dimension incorporating Soft Weighted Role-Family Equivalence multiplier
  const baseTitleScore = scoreTitleMatchImpl(jobTitleVariants, candidateTitleText);
  const candTitleLower = candidateTitleText.toLowerCase();
  const jobTitleLower = (req.title || "").toLowerCase();
  const hasDirectTitleOverlap = jobTitleLower.split(/\s+/).filter(w => w.length > 3).some(w => candTitleLower.includes(w));

  let roleFamilyMultiplier = 1.0;
  if (hasDirectTitleOverlap || req.roleFamilyMatch === "exact" || req.roleFamilyMatch === "synonym" || !req.roleFamilyMatch) {
    roleFamilyMultiplier = 1.0;
  } else if (req.roleFamilyMatch === "adjacent") {
    roleFamilyMultiplier = 0.85;
  } else if (req.roleFamilyMatch === "unrelated") {
    roleFamilyMultiplier = 0.70;
  }

  const titleScore = Math.round(roleFamilyMultiplier * baseTitleScore);

  const seniorityScore = calculateAsymmetricSeniorityScore(jobSeniority, candidateSeniority);
  const experienceScore = yearsScore(cv.yearsOfExperience ?? null, req.minYearsExperience, effectiveMaxYears);
  const skillScores = scoreSkills(requiredSkills, preferredSkills, candidateSkills);
  const hasMissingRequired = requiredSkills.length > 0 && skillScores.missingRequired.length > 0;
  const skillScore = skillScores.score;
  const targetIndustry = req.domainPreference || req.industry;
  const industryScore = scoreIndustry(targetIndustry, cv.industries ?? null);
  const targetLocation = req.overrideLocation || req.location;
  const locEval = evaluateLocationMatch(targetLocation, cv.location, req.strictLocation);
  const locationScore = locEval.score;
  const locationStatus = locEval.status;
  const locationGate = locEval.gate;
  const locationPenalty = locEval.penalty;

  let overallScore: number;
  if (titleScore === 0 && skillScore === 0) {
    // Hard domain isolation: Zero title match + Zero skill match = 0 score
    overallScore = 0;
  } else if (normalizedJobSeniority === "intern" || normalizedJobSeniority === "entry_level" || req.title?.toLowerCase().includes("intern")) {
    // For Intern / Entry Level roles, give higher weight to Seniority & Experience alignment
    overallScore = Math.round(
      (seniorityScore * 0.35) +
      (experienceScore * 0.25) +
      (titleScore * 0.20) +
      (skillScore * 0.20)
    );
  } else if (req.minYearsExperience != null) {
    overallScore = Math.round(
      (experienceScore * 0.30) +
      (titleScore * 0.30) +
      (seniorityScore * 0.20) +
      (skillScore * 0.20)
    );
  } else {
    overallScore = Math.round(
      (titleScore * 0.30) +
      (skillScore * 0.26) +
      (seniorityScore * 0.22) +
      (experienceScore * 0.16) +
      (industryScore * 0.06)
    );
  }

  // Universal Domain Compatibility Scaling (Applies to ALL industries):
  // If specific skills are required and candidate has 0 matching skills with weak title overlap, downrank cleanly
  if (requiredSkills.length > 0 && skillScore === 0 && titleScore < 70) {
    overallScore = Math.round(overallScore * 0.25);
  }

  // Apply Location Penalty (e.g. -40 points for strict location mismatch like Kegalle vs Colombo)
  if (locationPenalty < 0) {
    overallScore = Math.max(0, overallScore + locationPenalty);
  }

  // Evaluate Required Certifications if specified in custom preferences
  if (req.requiredCertifications && req.requiredCertifications.length > 0) {
    const candCertsText = normalizeText(`${(cv.certifications || []).join(" ")} ${cv.summary || ""}`);
    let certMatches = 0;
    for (const cert of req.requiredCertifications) {
      if (candCertsText.includes(normalizeText(cert))) {
        certMatches++;
      }
    }
    if (certMatches === 0) {
      overallScore = Math.max(10, overallScore - 20);
    }
  }

  // Apply negative keywords penalty if TA feedback extracted negative keywords
  if (req.negativeKeywords && req.negativeKeywords.length > 0) {
    const candidateTextNorm = normalizeText(`${candidateTitleText} ${(cv.skills || []).join(" ")}`);
    for (const negWord of req.negativeKeywords) {
      if (candidateTextNorm.includes(normalizeText(negWord))) {
        overallScore = Math.max(5, overallScore - 30);
        break;
      }
    }
  }

  // Apply Current-Role Level Gate soft penalty if candidate is 2+ levels below job target rank
  if (typeof req.currentRolePenalty === "number" && req.currentRolePenalty < 0) {
    overallScore = Math.max(0, overallScore + req.currentRolePenalty);
  }

  // Incorporate vectorScore if present
  if ((cv as any).vectorScore !== undefined) {
    const semanticScore = Math.round((cv as any).vectorScore * 100);
    overallScore = Math.round(overallScore * 0.60 + semanticScore * 0.40);
  }

  const titleReason =
    titleScore >= 90 ? "The title is a near-direct match."
      : titleScore >= 75 ? "The title is a good variation of the target role."
      : titleScore >= 60 ? "The title is related to the target role."
      : "The title is only loosely related, but still worth considering.";

  const experienceReason =
    req.minYearsExperience == null
      ? candidateSeniority
        ? `Seniority appears to be ${candidateSeniority}.`
        : "Seniority is not clearly stated."
      : cv.yearsOfExperience != null
        ? `${cv.yearsOfExperience} years of experience versus the ${req.minYearsExperience}+ year target.`
        : "Years of experience could not be clearly confirmed.";

  const skillReason =
    hasMissingRequired
      ? `Missing required skills: ${skillScores.missingRequired.slice(0, 4).join(", ")}${skillScores.missingRequired.length > 4 ? ", and more" : ""}.`
      : skillScores.matchedRequired.length > 0
        ? `Matches ${skillScores.matchedRequired.slice(0, 4).join(", ")}${skillScores.matchedRequired.length > 4 ? ", and more" : ""}.`
        : req.requiredSkills.length > 0
          ? "Shows a partial skill fit rather than a complete one."
          : "No explicit skill filter was provided.";

  return {
    index,
    cv,
    titleScore,
    seniorityScore,
    experienceScore,
    skillScore,
    industryScore,
    locationScore,
    overallScore,
    locationStatus,
    locationGate,
    locationPenalty,
    matchedRequired: skillScores.matchedRequired,
    missingRequired: skillScores.missingRequired,
    matchedPreferred: skillScores.matchedPreferred,
    reason: `${titleReason} ${experienceReason} ${skillReason}`.trim(),
  };
}

export async function scoreWithLLM(
  cv: any,
  req: SearchRequirements
): Promise<{
  result: { score: number; reason: string };
  usage: { promptTokens: number; completionTokens: number; model: string };
}> {
  const model = getModelForTask("cv_scoring");
  const openai = getOpenAI("cv_scoring");

  try {
    const candidateObj = cv.cv || cv;

    const candName = candidateObj.fullName || "Candidate";
    const candTitle = candidateObj.currentTitle || candidateObj.currentJobTitle || "Not specified";
    const candEmployer = candidateObj.currentEmployer || "Not specified";
    const candYears = candidateObj.totalExperienceYears ?? candidateObj.totalYearsExperience ?? candidateObj.yearsOfExperience ?? "Not specified";
    const candSkills = Array.isArray(candidateObj.skills)
      ? candidateObj.skills.map((s: any) => (typeof s === "object" ? s.value : String(s))).slice(0, 20).join(", ")
      : "Not specified";

    const recentJobs = Array.isArray(candidateObj.jobHistory)
      ? candidateObj.jobHistory.slice(0, 3).map((j: any) => `- ${j.title || "Role"} at ${j.company || "Company"} (${j.startDate || ""} - ${j.endDate || "Present"})`).join("\n")
      : "";

    const reqSkills = Array.isArray(req.requiredSkills) ? req.requiredSkills.join(", ") : "Not specified";
    const prefSkills = Array.isArray(req.preferredSkills) ? req.preferredSkills.join(", ") : "None";
    const jdSnippet = req.summary ? String(req.summary).slice(0, 500) : "";

    const userPrompt = [
      `JOB REQUIREMENTS:`,
      `Title: ${req.title || "Not specified"}`,
      `Required Skills: ${reqSkills}`,
      `Preferred Skills: ${prefSkills}`,
      `Min Experience: ${req.minYearsExperience ?? "Not specified"} years`,
      `Seniority: ${req.seniority || "Not specified"}`,
      `Industry: ${req.industry || "Not specified"}`,
      jdSnippet ? `Summary: ${jdSnippet}` : "",
      ``,
      `CANDIDATE PROFILE:`,
      `Name: ${candName}`,
      `Current Title: ${candTitle}`,
      `Current Employer: ${candEmployer}`,
      `Total Experience: ${candYears} years`,
      `Skills: ${candSkills}`,
      recentJobs ? `Recent Roles:\n${recentJobs}` : "",
    ].filter(Boolean).join("\n");

    const response = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `You are a Senior Talent Acquisition (TA) Recruiter. Evaluate how well the candidate's CV aligns with the job requirements. Write all evaluations strictly in English. Do NOT output Chinese or any other language. Return ONLY a JSON object: {"score": number, "reason": "A 2-3 sentence professional TA evaluation in English explaining why this candidate is a match, highlighting key matching skills, relevant experience, and overall role fit."}`
        },
        {
          role: "user",
          content: userPrompt,
        }
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? '{"score":0}';
    const inputTokens = response.usage?.prompt_tokens || 0;
    const outputTokens = response.usage?.completion_tokens || 0;

    try {
      const parsed = JSON.parse(content) as { score?: number, reason?: string };
      return {
        result: {
          score: Math.min(100, Math.max(0, parsed.score ?? 0)),
          reason: parsed.reason || "The candidate's profile was evaluated against the job requirements."
        },
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          model,
        },
      };
    } catch (parseError) {
      throw new Error(`Error parsing AI evaluation: ${String(parseError)}`);
    }
  } catch (error) {
    throw error;
  }
}

export function selectLlmPool(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const topByOverall = candidates.slice(0, 15);
  const topBySkills = [...candidates]
    .sort((a, b) => b.skillScore - a.skillScore)
    .slice(0, 5);
  const seenIds = new Set(topByOverall.map((c) => c.cv._id));
  return [
    ...topByOverall,
    ...topBySkills.filter((c) => !seenIds.has(c.cv._id)),
  ];
}

export function buildDeterministicTaReason(candidate: ScoredCandidate, req: SearchRequirements): string {
  const name = candidate.cv.fullName || "Candidate";
  const title = candidate.cv.currentTitle || "Professional";
  const exp = candidate.cv.yearsOfExperience ?? (candidate.cv as any).totalExperienceYears;
  const matched = (candidate.matchedRequired || []).slice(0, 4);
  const missing = (candidate.missingRequired || []).slice(0, 3);

  // Determine job's primary skill domain for match confidence
  const reqSkills = req.requiredSkills ?? [];
  const jobSkillDomains = new Set(
    reqSkills.map((s: string) => getSkillDomain(s)).filter((d: string) => d !== "unknown")
  );
  const primaryJobDomain = jobSkillDomains.size > 0 ? [...jobSkillDomains][0] : "unknown";

  const matchedDomains = new Set(
    (candidate.matchedRequired || []).map((s: string) => getSkillDomain(s))
  );
  const domainAlignedMatches = [...matchedDomains].filter((d: string) => d === primaryJobDomain).length;

  let matchConfidence: "high" | "medium" | "low" = "low";
  if (domainAlignedMatches >= 3) matchConfidence = "high";
  else if (domainAlignedMatches >= 1) matchConfidence = "medium";
  if (primaryJobDomain === "unknown" && matched.length > 0) matchConfidence = "medium";

  let parts: string[] = [];
  if (candidate.overallScore >= 85) {
    parts.push(`Strong TA match for ${req.title || "the role"}. ${name} shows high domain alignment as a ${title}.`);
  } else if (candidate.overallScore >= 60) {
    parts.push(`Suitable candidate with relevant background as a ${title}.`);
  } else {
    parts.push(`Partial alignment match for ${req.title || "the role"} based on background as a ${title}.`);
  }

  if (matched.length > 0) {
    parts.push(`Key matching skills: ${matched.join(", ")}.`);
    if (matchConfidence === "low") {
      parts.push(`Note: Matched skills may be tangentially related — verify domain relevance.`);
    }
  }
  if (exp != null) parts.push(`Brings ${exp} years of total professional experience.`);
  if (missing.length > 0) parts.push(`Skill gaps to note: ${missing.join(", ")}.`);

  return parts.join(" ");
}

export type BatchScoreResult = {
  evaluations: Map<number, { score: number; reason: string }>;
  usage: { promptTokens: number; completionTokens: number; model: string };
};

export async function scoreBatchWithLLM(
  candidates: ScoredCandidate[],
  req: SearchRequirements,
  taskType: string = "search_ranking"
): Promise<BatchScoreResult> {
  if (candidates.length === 0) {
    return {
      evaluations: new Map(),
      usage: { promptTokens: 0, completionTokens: 0, model: getModelForTask(taskType) },
    };
  }

  const model = getModelForTask(taskType);
  const openai = getOpenAI(taskType);

  const reqSkills = Array.isArray(req.requiredSkills) ? req.requiredSkills.join(", ") : "Not specified";
  const prefSkills = Array.isArray(req.preferredSkills) ? req.preferredSkills.join(", ") : "None";
  const jdSnippet = req.summary ? String(req.summary).slice(0, 350) : "";

  const candidateSerializedList = candidates.map((c) => {
    const cvObj = c.cv || {};
    const name = cvObj.fullName || `Candidate #${c.index}`;
    const title = cvObj.currentTitle || (cvObj as any).currentJobTitle || "Not specified";
    const employer = cvObj.currentEmployer ? `@ ${cvObj.currentEmployer}` : "";
    const exp = cvObj.yearsOfExperience ?? (cvObj as any).totalExperienceYears ?? "N/A";
    const skills = Array.isArray(cvObj.skills)
      ? cvObj.skills.map((s: any) => (typeof s === "object" ? s.value : String(s))).slice(0, 10).join(", ")
      : "Not specified";

    return `[ID: ${c.index}] ${name} | ${title} ${employer} | ${exp} yrs exp | Skills: ${skills}`;
  });

  const promptText = [
    `JOB REQUIREMENTS:`,
    `Title: ${req.title || "Not specified"}`,
    `Required Skills: ${reqSkills}`,
    `Preferred Skills: ${prefSkills}`,
    `Min Experience: ${req.minYearsExperience ?? "Not specified"} years`,
    `Seniority: ${req.seniority || "Not specified"}`,
    `Industry: ${req.industry || "Not specified"}`,
    jdSnippet ? `Summary: ${jdSnippet}` : "",
    ``,
    `CANDIDATE POOL TO EVALUATE:`,
    ...candidateSerializedList,
  ].filter(Boolean).join("\n");

  const systemPrompt = `You are a Senior Talent Acquisition (TA) Recruiter. Evaluate how well EACH candidate in the candidate pool aligns with the job requirements. Write all evaluations strictly in English. Do NOT output Chinese or any other language. Return ONLY a JSON object mapping candidate IDs to evaluation result objects:
{
  "evaluations": [
    {
      "id": number,
      "score": number (0-100),
      "reason": "1-2 sentence TA evaluation in English highlighting key matching skills, experience, and role fit."
    }
  ]
}`;

  try {
    let content = "{}";
    let usedModel = model;

    try {
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 4000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptText },
        ],
        response_format: { type: "json_object" },
      });
      content = response.choices[0]?.message?.content ?? '{"evaluations":[]}';
    } catch (primaryErr: any) {
      console.warn("[scoreBatchWithLLM] Primary model call failed, trying OpenRouter fallback:", primaryErr?.message || primaryErr);
      const fallbackClient = getOpenAI("cv_structuring");
      const fallbackResponse = await fallbackClient.chat.completions.create({
        model: "deepseek/deepseek-v4-flash",
        temperature: 0.1,
        max_tokens: 4000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptText },
        ],
        response_format: { type: "json_object" },
      });
      content = fallbackResponse.choices[0]?.message?.content ?? '{"evaluations":[]}';
      usedModel = "deepseek/deepseek-v4-flash";
    }

    // Clean any markdown formatting and control characters if present
    content = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, " ")
      .trim();

    const resultMap = new Map<number, { score: number; reason: string }>();

    try {
      const parsed = JSON.parse(content) as { evaluations?: { id?: number; score?: number; reason?: string }[] };
      const evals = parsed.evaluations || [];
      for (const item of evals) {
        if (typeof item.id === "number") {
          resultMap.set(item.id, {
            score: Math.min(100, Math.max(0, item.score ?? 50)),
            reason: item.reason || "Evaluated by AI matching engine against job requirements.",
          });
        }
      }
    } catch (parseError) {
      console.warn("[scoreBatchWithLLM] Standard JSON parse failed, attempting regex chunk extraction:", parseError);
      
      // Fallback regex extraction if JSON was truncated or had unescaped string syntax
      const itemRegex = /\{\s*"id"\s*:\s*(\d+)[\s\S]*?"score"\s*:\s*(\d+)(?:[\s\S]*?"reason"\s*:\s*"([^"]*)")?/g;
      let match: RegExpExecArray | null;
      while ((match = itemRegex.exec(content)) !== null) {
        const id = parseInt(match[1], 10);
        const score = Math.min(100, Math.max(0, parseInt(match[2], 10)));
        const reason = match[3] || "Evaluated by AI matching engine against job requirements.";
        resultMap.set(id, { score, reason });
      }
    }

    return {
      evaluations: resultMap,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        model: usedModel,
      },
    };
  } catch (err) {
    console.error("[scoreBatchWithLLM] LLM call error:", err);
    return {
      evaluations: new Map(),
      usage: { promptTokens: 0, completionTokens: 0, model },
    };
  }
}

