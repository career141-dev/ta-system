// convex/lib/jobRequirements.ts
//
// Turning what the JD extractor says into what the `jobs` row can hold.
//
// Pure functions, no I/O, so the rules are tested directly
// (tests/jobrequirements.test.ts). They fix the three ways the older Create
// Job page mis-saved an extraction:
//
//   seniority  "senior" / "lead" were not values of the schema's enum, so the
//              save either failed or stored nonsense
//   salary     "200k - 300k LKR" became 200 / 300 with currency "kkLKR"
//   industry   the model's free text was never mapped to the option list
//
// The same field vocabulary is used by the Job details panel, so a value the
// extractor writes is always one the form can show and save back.

export const SENIORITY_LEVELS = [
  "entry_level", "mid_level", "executive", "senior_executive", "manager",
  "senior_manager", "agm", "gm", "director", "c_suite", "other",
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const SENIORITY_LABEL: Record<SeniorityLevel, string> = {
  entry_level: "Entry-Level", mid_level: "Mid-Level", executive: "Executive",
  senior_executive: "Senior Executive", manager: "Manager", senior_manager: "Senior Manager",
  agm: "AGM", gm: "GM", director: "Director", c_suite: "C-Suite", other: "Other",
};

export const INDUSTRIES = [
  "FMCG", "Finance", "Technology", "Apparel", "Healthcare", "Retail", "Manufacturing", "Telecoms", "Other",
] as const;

export const EDUCATION_LEVELS = [
  "any", "diploma", "bachelor", "master", "phd", "professional_cert", "bachelor_or_master",
] as const;

export const EDUCATION_LABEL: Record<(typeof EDUCATION_LEVELS)[number], string> = {
  any: "Any", diploma: "Diploma", bachelor: "Bachelor's", master: "Master's", phd: "PhD",
  professional_cert: "Professional certification", bachelor_or_master: "Bachelor's or Master's",
};

export const RECRUITMENT_TYPES = ["both", "headhunting", "job_posting"] as const;

/** The fields this module manages, by their `jobs` column names. */
export const REQUIREMENT_FIELDS = [
  "requiredSkills", "niceToHaveSkills", "seniorityLevel", "experienceMinYears", "experienceMaxYears",
  "location", "educationLevel", "languagesRequired", "salaryMin", "salaryMax", "salaryCurrency", "clientIndustry",
] as const;
export type RequirementField = (typeof REQUIREMENT_FIELDS)[number];

export interface RequirementValues {
  requiredSkills: string[];
  niceToHaveSkills: string[];
  seniorityLevel: SeniorityLevel;
  experienceMinYears: number;
  experienceMaxYears: number | undefined;
  location: string;
  educationLevel: string | undefined;
  languagesRequired: string[];
  salaryMin: number | undefined;
  salaryMax: number | undefined;
  salaryCurrency: string | undefined;
  clientIndustry: string;
}

/** What the extractor returns (convex/lib/jdParser.ts SearchRequirements), loosely. */
export interface Extracted {
  requiredSkills?: string[] | null;
  preferredSkills?: string[] | null;
  minYearsExperience?: number | string | null;
  maxYearsExperience?: number | string | null;
  industry?: string | null;
  seniority?: string | null;
  location?: string | null;
  education?: string | null;
  languages?: string[] | null;
  salaryRange?: string | null;
}

// ─── Field rules ─────────────────────────────────────────────────────────────

/**
 * Split pasted skills on commas, semicolons, newlines and bullets; trim;
 * de-duplicate case-insensitively.
 *
 * Never inside brackets: "Version Control (e.g. Git, SVN)" is one skill. It
 * was cut at every comma, and because a saved list went through here again on
 * each save, "Version Control (e.g." and "Git)" became two tags (testing,
 * 21 Sep). Pieces already broken that way are joined back while an opening
 * bracket is still unclosed, so the next save repairs them.
 */
export function splitSkills(input: string | string[] | null | undefined): string[] {
  const pieces: string[] = [];
  let open = "";
  for (const item of Array.isArray(input) ? input : [input ?? ""]) {
    for (const part of splitOutsideBrackets(String(item ?? ""))) {
      // A piece left with an unclosed "(" takes the next ones until it closes.
      open = open ? `${open}, ${part.trim()}` : part;
      if (bracketDepth(open) <= 0) {
        pieces.push(open);
        open = "";
      }
    }
  }
  if (open) pieces.push(open);
  const parts = pieces
    .map((s) => s.replace(/^[\s\-*]+|\s+$/g, "").replace(/\s+/g, " "))
    .filter((s) => s.length > 0 && s.length <= 80);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, 40);
}

/** Brackets opened and not yet closed in a piece of text. */
function bracketDepth(text: string): number {
  let d = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "[") d++;
    else if ((ch === ")" || ch === "]") && d > 0) d--;
  }
  return d;
}

/** Split on , ; newline and bullets, except inside ( ) or [ ]. */
function splitOutsideBrackets(text: string): string[] {
  const out: string[] = [];
  let d = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") d++;
    else if ((ch === ")" || ch === "]") && d > 0) d--;
    if (d === 0 && /[,;\n•·|]/.test(ch)) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.filter((p) => p.trim());
}

/** Any wording the model or a person uses, onto the schema's eleven levels. */
export function mapSeniority(raw: string | null | undefined): SeniorityLevel | null {
  const s = String(raw ?? "").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if ((SENIORITY_LEVELS as readonly string[]).includes(s.replace(/ /g, "_"))) return s.replace(/ /g, "_") as SeniorityLevel;
  if (/\b(c suite|cxo|ceo|cfo|coo|cto|cio|chief)\b/.test(s)) return "c_suite";
  if (/\b(assistant general manager|agm)\b/.test(s)) return "agm";
  if (/\b(general manager|gm)\b/.test(s)) return "gm";
  if (/\b(director|head of|vp|vice president)\b/.test(s)) return "director";
  if (/\bsenior manager\b/.test(s)) return "senior_manager";
  if (/\b(manager|lead|head)\b/.test(s)) return "manager";
  if (/\bsenior executive\b/.test(s)) return "senior_executive";
  if (/\b(senior|sr)\b/.test(s)) return "senior_executive";
  if (/\bexecutive\b/.test(s)) return "executive";
  if (/\b(mid|middle|intermediate|associate)\b/.test(s)) return "mid_level";
  if (/\b(entry|junior|jr|graduate|trainee|intern|fresher)\b/.test(s)) return "entry_level";
  return "other";
}

/** Free-text industry onto the option list; anything unrecognised is "Other". */
export function mapIndustry(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").toLowerCase();
  if (!s.trim()) return null;
  const exact = INDUSTRIES.find((i) => i.toLowerCase() === s.trim());
  if (exact) return exact;
  if (/fmcg|consumer goods|beverage|food|personal care/.test(s)) return "FMCG";
  if (/bank|financ|insurance|account|audit|fintech|investment|leasing/.test(s)) return "Finance";
  if (/tech|software|\bit\b|information technology|saas|digital|data/.test(s)) return "Technology";
  if (/apparel|garment|textile|fashion/.test(s)) return "Apparel";
  if (/health|\bhospitals?\b|pharma|medical|clinic/.test(s)) return "Healthcare";
  if (/retail|e-?commerce|supermarket/.test(s)) return "Retail";
  if (/manufactur|industrial|factory|engineering|automotive/.test(s)) return "Manufacturing";
  if (/telecom|telco|mobile network/.test(s)) return "Telecoms";
  return "Other";
}

/** Education wording onto the option values; unrecognised text is kept as written. */
export function mapEducation(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  const s = text.toLowerCase();
  if (!s) return null;
  if ((EDUCATION_LEVELS as readonly string[]).includes(s)) return s;
  const bachelor = /bachelor|\bbsc\b|\bba\b|\bbcom\b|degree|graduate/.test(s);
  const master = /master|\bmsc\b|\bmba\b|\bma\b|postgraduate/.test(s);
  if (/phd|doctorate/.test(s)) return "phd";
  if (bachelor && master) return "bachelor_or_master";
  if (master) return "master";
  if (bachelor) return "bachelor";
  if (/cima|acca|ca sri lanka|chartered|certif|professional qualification|\bcpa\b|\bpmp\b/.test(s)) return "professional_cert";
  if (/diploma|\bhnd\b|\ba\/l\b|advanced level/.test(s)) return "diploma";
  if (/any|not required|none/.test(s)) return "any";
  return text.slice(0, 120);
}

const CURRENCY_WORDS: Record<string, string> = {
  rs: "LKR", "rs.": "LKR", rupees: "LKR", lkr: "LKR", usd: "USD", "$": "USD", aed: "AED", sar: "SAR",
  qar: "QAR", omr: "OMR", kwd: "KWD", bhd: "BHD", gbp: "GBP", "£": "GBP", eur: "EUR", "€": "EUR",
  inr: "INR", pkr: "PKR", bdt: "BDT", mvr: "MVR", sgd: "SGD", myr: "MYR", aud: "AUD", cad: "CAD",
};

/**
 * "200k - 300k LKR" → 200000 / 300000 / LKR. Handles k, m/mn, lakh; commas;
 * "Rs." and symbols; a single figure (min only); "up to 300k" (max only).
 */
export function parseSalaryRange(
  raw: string | null | undefined,
  defaultCurrency = "LKR",
): { min: number | undefined; max: number | undefined; currency: string | undefined } {
  const text = String(raw ?? "").trim();
  if (!text) return { min: undefined, max: undefined, currency: undefined };
  const lower = text.toLowerCase();

  let currency: string | undefined;
  const code = lower.match(/\b(lkr|usd|aed|sar|qar|omr|kwd|bhd|gbp|eur|inr|pkr|bdt|mvr|sgd|myr|aud|cad|rupees|rs\.?)(?=\b|\s|\d|$)/);
  if (code) currency = CURRENCY_WORDS[code[1]];
  else if (text.includes("$")) currency = "USD";
  else if (text.includes("£")) currency = "GBP";
  else if (text.includes("€")) currency = "EUR";

  const found: { base: number; mult: number }[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|mn|m|million|lakhs?|lacs?)?(?![a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const unit = (m[2] ?? "").toLowerCase();
    const mult = unit === "k" ? 1_000 : unit.startsWith("m") ? 1_000_000 : unit.startsWith("la") ? 100_000 : 1;
    found.push({ base, mult });
  }
  // "200 - 300k": a bare small first figure shares the unit of the second.
  if (found.length >= 2 && found[0].mult === 1 && found[1].mult > 1 && found[0].base < 1_000) {
    found[0].mult = found[1].mult;
  }
  const plausible = found.map((f) => Math.round(f.base * f.mult)).filter((n) => n > 0 && n <= 1_000_000_000);
  if (plausible.length === 0) return { min: undefined, max: undefined, currency };

  const upTo = /\b(up to|upto|max(imum)?|not more than|below|under)\b/.test(lower);
  if (plausible.length === 1) {
    return upTo
      ? { min: undefined, max: plausible[0], currency: currency ?? defaultCurrency }
      : { min: plausible[0], max: undefined, currency: currency ?? defaultCurrency };
  }
  const [a, b] = plausible;
  return { min: Math.min(a, b), max: Math.max(a, b), currency: currency ?? defaultCurrency };
}

function years(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").match(/\d+(\.\d+)?/)?.[0]);
  if (!Number.isFinite(n) || n < 0 || n > 50) return undefined;
  return Math.round(n);
}

/** One extraction → the candidate values for each field (undefined = the JD says nothing). */
export function valuesFromExtraction(x: Extracted): Partial<RequirementValues> {
  const salary = parseSalaryRange(x.salaryRange);
  const min = years(x.minYearsExperience);
  let max = years(x.maxYearsExperience);
  if (min !== undefined && max !== undefined && max < min) max = undefined;
  const out: Partial<RequirementValues> = {};
  // The model often repeats the education line as a "skill" ("CIMA passed
  // finalist or ACCA"); it belongs in Education, and as a skill it matches nobody.
  const educationText = String(x.education ?? "").trim().toLowerCase();
  const req = splitSkills(x.requiredSkills ?? []).filter((s) => !educationText || s.toLowerCase() !== educationText);
  const nice = splitSkills(x.preferredSkills ?? []).filter((s) => !req.some((r) => r.toLowerCase() === s.toLowerCase()));
  if (req.length) out.requiredSkills = req;
  if (nice.length) out.niceToHaveSkills = nice;
  const seniority = mapSeniority(x.seniority);
  if (seniority) out.seniorityLevel = seniority;
  if (min !== undefined) out.experienceMinYears = min;
  if (max !== undefined) out.experienceMaxYears = max;
  const location = String(x.location ?? "").trim();
  if (location && !/^(null|n\/a|not specified|remote\?)$/i.test(location)) out.location = location.slice(0, 160);
  const education = mapEducation(x.education);
  if (education) out.educationLevel = education;
  const languages = splitSkills(x.languages ?? []);
  if (languages.length) out.languagesRequired = languages;
  if (salary.min !== undefined) out.salaryMin = salary.min;
  if (salary.max !== undefined) out.salaryMax = salary.max;
  if (salary.min !== undefined || salary.max !== undefined) out.salaryCurrency = salary.currency;
  const industry = mapIndustry(x.industry);
  if (industry) out.clientIndustry = industry;
  return out;
}

/** Placeholders written at creation, before anyone had read a JD — safe to replace. */
function isPlaceholder(field: RequirementField, current: unknown): boolean {
  if (current === undefined || current === null || current === "") return true;
  if (Array.isArray(current)) return current.length === 0;
  if (field === "seniorityLevel") return current === "mid_level";
  if (field === "experienceMinYears") return current === 2 || current === 0;
  if (field === "clientIndustry") return current === "Other";
  if (field === "location") return ["sri lanka", "remote", "unknown"].includes(String(current).toLowerCase());
  return false;
}

/**
 * The patch to apply.
 *
 *   mode "fill"    — automatic, on approval or a JD edit: never touches a field a
 *                    person locked, and only replaces blanks/placeholders.
 *   mode "replace" — the TA pressed Re-extract: every field the JD speaks to is
 *                    replaced, and the locks are cleared.
 */
export function mergeRequirements(
  current: Partial<Record<RequirementField, unknown>>,
  extracted: Partial<RequirementValues>,
  opts: { mode: "fill" | "replace"; locked: string[] },
): Partial<RequirementValues> {
  const patch: Partial<RequirementValues> = {};
  for (const field of REQUIREMENT_FIELDS) {
    const value = extracted[field];
    if (value === undefined) continue;
    if (opts.mode === "fill") {
      if (opts.locked.includes(field)) continue;
      if (!isPlaceholder(field, current[field])) continue;
    }
    (patch as Record<string, unknown>)[field] = value;
  }
  return patch;
}
