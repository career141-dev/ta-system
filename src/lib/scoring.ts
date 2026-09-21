/**
 * How well a candidate fits an opening.
 *
 * Ported from the live system's `cvScoring`, which gets the hard part right:
 * the arithmetic is deterministic and the model is used sparingly, on a chosen
 * few, for the sentence rather than the number. A model asked for a total will
 * produce a plausible one; a model asked to explain a total it was given
 * cannot change it.
 *
 * Four things are deliberately different from the original.
 *
 *   **Every candidate is scored on the same scale.** The original folded a
 *   semantic score in "if present", so a candidate with an embedding was scored
 *   0.6·deterministic + 0.4·vector and one without on the deterministic alone —
 *   and then both were ranked in the same list. Here the blend is decided once
 *   for the whole set: either everyone has a vector or nobody's is used.
 *
 *   **No hard zero.** The original forced 0 when title and skills both missed,
 *   which deletes career changers and anybody whose CV uses different words for
 *   the same work — the people a headhunting desk is paid to find. They floor
 *   at 12 and sink to the bottom, where a TA can still see them.
 *
 *   **Weights are per discipline and overridable per opening.** Finance and
 *   apparel design should not weight skills identically, and in the original
 *   they did.
 *
 *   **It is type-checked.** The original carries `@ts-nocheck` across all 1,526
 *   lines of the file that decides who gets seen.
 */

import type { Candidate } from "@/data/types";
import { localOnlyFromJd, locationFit } from "./places";
import { industryExperience, industryWanted, normaliseIndustry } from "./profileInfer";

// ─── the inputs ──────────────────────────────────────────────────────────────

export interface Requirements {
  /**
   * What the JD asks for that is not a named skill — "Strong stakeholder
   * management", "Proven experience in a comparable role".
   *
   * These have to be scored differently from skills, and getting that wrong is
   * what made the first ranked list useless: read as skills, they matched
   * nobody's skill list, so every candidate scored zero on skills and twenty
   * people tied. They are scored by word overlap against the whole record
   * instead, which is the most an honest reading of a sentence like that can
   * give.
   */
  qualitativeMusts?: string[];
  title: string;
  /** Title variants worth counting as the same job. */
  titleVariants: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  minYears: number | null;
  seniority: Seniority | null;
  locations: string[];
  /** Years leading people or a function, when the JD states it separately. */
  managementYears?: number | null;
  /** Stems naming the work, from the job title; see coreTermsOf. */
  coreTerms?: string[];
  /** The JD says experience in `industries` is a must, not a plus (13 September). */
  industryRequired?: boolean;
  /** The JD says local candidates only: someone based in another country is out. */
  localOnly?: boolean;
  /** A hard requirement where the client stated one. */
  nationalities: string[];
  industries: string[];
  requiredQualifications: string[];
  /** Named under "preferred": earn a little, never cost anything. */
  preferredQualifications?: string[];
  /** Learned from what the TA rejected. */
  negativeKeywords: string[];
  discipline: Discipline;
}

/**
 * The one set of bands every screen uses (13 September review: the assistant
 * called 70+ strong while this module called 85+ strong). The score is a
 * ranking index, not a calibrated "percentage suitable": these lines were read
 * off blind-judged live results and will move when TA-reviewed data exists.
 */
export const FIT_BANDS = { strong: 75, worth: 60 } as const;

export type Seniority =
  | "intern" | "junior" | "mid" | "senior" | "lead" | "executive";

export type Discipline =
  | "general" | "finance" | "engineering" | "design" | "sales" | "operations" | "hr";

// ─── weights ─────────────────────────────────────────────────────────────────

export interface Weights {
  title: number;
  skills: number;
  seniority: number;
  experience: number;
  industry: number;
}

/**
 * What matters, by the kind of work.
 *
 * A finance role is a qualification and a seniority; a design role is a
 * portfolio of skills and much less about the job title, which varies wildly
 * between houses. These are starting points a desk can argue with, not truths —
 * which is the point of having them per discipline rather than one set.
 */
export const DISCIPLINE_WEIGHTS: Record<Discipline, Weights> = {
  general:     { title: 0.30, skills: 0.26, seniority: 0.22, experience: 0.16, industry: 0.06 },
  finance:     { title: 0.26, skills: 0.24, seniority: 0.24, experience: 0.20, industry: 0.06 },
  engineering: { title: 0.22, skills: 0.40, seniority: 0.18, experience: 0.16, industry: 0.04 },
  design:      { title: 0.18, skills: 0.42, seniority: 0.18, experience: 0.14, industry: 0.08 },
  sales:       { title: 0.30, skills: 0.18, seniority: 0.22, experience: 0.18, industry: 0.12 },
  operations:  { title: 0.30, skills: 0.24, seniority: 0.22, experience: 0.18, industry: 0.06 },
  hr:          { title: 0.32, skills: 0.24, seniority: 0.22, experience: 0.16, industry: 0.06 },
};

/** Where the job states a minimum, experience earns its weight from title. */
const YEARS_STATED: Partial<Weights> = { experience: 0.30, title: 0.24 };

/** For an intern, what they have done matters less than where they are. */
const ENTRY: Weights = { seniority: 0.35, experience: 0.25, title: 0.20, skills: 0.20, industry: 0 };

export function weightsFor(req: Requirements, override?: Partial<Weights>): Weights {
  const base =
    req.seniority === "intern"
      ? ENTRY
      : { ...DISCIPLINE_WEIGHTS[req.discipline], ...(req.minYears != null ? YEARS_STATED : {}) };

  const merged = { ...base, ...override } as Weights;
  // Whatever the desk sets, the parts still have to make a whole.
  const total = merged.title + merged.skills + merged.seniority + merged.experience + merged.industry;
  if (total <= 0) return DISCIPLINE_WEIGHTS.general;
  return {
    title: merged.title / total,
    skills: merged.skills / total,
    seniority: merged.seniority / total,
    experience: merged.experience / total,
    industry: merged.industry / total,
  };
}

// ─── the parts ───────────────────────────────────────────────────────────────

const norm = (v: string) =>
  v.toLowerCase().replace(/[^\p{L}\p{N}#+./-]+/gu, " ").replace(/\s+/g, " ").trim();

const ALIAS: [RegExp, string][] = [
  [/\bnode\s*\.?\s*js\b/g, "nodejs"], [/\breact\s*\.?\s*js\b/g, "reactjs"],
  [/\bc\+\+/g, "cplusplus"], [/\bc#/g, "csharp"], [/\b\.net\b/g, "dotnet"],
  [/\bci\s*[\/-]\s*cd\b/g, "cicd"], [/\bpower\s*bi\b/g, "powerbi"],
  [/\b(ms|microsoft)\s*excel\b/g, "excel"], [/\bsql\s*server\b/g, "sqlserver"],
  [/\bdata\s*analysis\b/g, "analytics"], [/\bqa\b/g, "quality assurance"],
];

export function normSkill(v: string): string {
  let s = v.toLowerCase().trim();
  for (const [re, to] of ALIAS) s = s.replace(re, to);
  return norm(s);
}

const RANKS: Record<Seniority, number> = {
  intern: 0, junior: 1, mid: 2, senior: 3, lead: 4, executive: 5,
};

export function seniorityOf(text: string): Seniority | null {
  const t = norm(text);
  if (/\bintern\b|\btrainee\b/.test(t)) return "intern";
  // Order matters, and the specific titles come first. "Assistant General
  // Manager" contains both "assistant" and "general manager", and testing the
  // generic word first called an AGM junior (audit finding 49).
  if (/\b(?:assistant|deputy) general manager\b|\bagm\b|\bdgm\b/.test(t)) return "lead";
  if (/\bexecutive assistant\b|\bpersonal assistant\b/.test(t)) return "junior";
  if (/\bchief\b|\bc-?suite\b|\bcfo\b|\bceo\b|\bcoo\b|\bcto\b|\bchro\b|\bdirector\b|\bvp\b|\bvice president\b|\bgeneral manager\b/.test(t)) return "executive";
  // "Assistant Brand Manager", "Assistant Procurement Manager": still an assistant manager.
  // One step below a manager in this market, not two (13 September: assistant
  // procurement managers were marked "well below" a Procurement Manager role).
  if (/\bassistant (?:\w+ ){0,2}manager\b/.test(t)) return "senior";
  if (/\bhead of\b|\blead\b|\bprincipal\b|\bmanager\b/.test(t)) return "lead";
  if (/\bjunior\b|\bjr\b|\bentry level\b|\bassistant\b/.test(t)) return "junior";
  if (/\bsenior\b|\bsr\b/.test(t)) return "senior";
  if (/\bmid level\b|\bexecutive\b|\bofficer\b/.test(t)) return "mid";
  return null;
}

/**
 * Distance in seniority, punished asymmetrically.
 *
 * The one genuinely hard-won idea in the original, kept as it was: being too
 * senior is worse than being too junior, and it gets worse faster. A GM
 * applying for an executive role is a poorer bet than an executive applying for
 * a GM role — they will be bored, expensive, or gone in a year.
 */
export function seniorityScore(want: Seniority | null, has: Seniority | null): number {
  if (!want) return has ? 80 : 72;
  if (!has) return 70;
  const d = RANKS[has] - RANKS[want];
  if (d === 0) return 100;
  if (d > 0) return Math.max(5, Math.round(100 * Math.exp(-0.45 * Math.pow(d, 1.4))));
  return Math.max(10, Math.round(100 - 22 * Math.abs(d)));
}

const STOP = new Set([
  "junior", "jr", "mid", "senior", "sr", "lead", "principal", "assistant",
  "associate", "staff", "entry", "level", "of", "and", "the", "a", "an",
]);

/**
 * Words that say how senior a job is, not what the job is. A title sharing only
 * these with the job ("Manager Legal" against "Audit Manager") is a different
 * job, and seniority is scored separately.
 */
const RANK_WORDS = new Set([
  "manager", "officer", "executive", "head", "director", "chief", "deputy", "general",
  "assistant", "associate", "senior", "junior", "lead", "principal", "specialist",
  "registered", "grade", "trainee", "intern", "supervisor", "consultant", "team", "group", "staff",
]);

/**
 * A crude stem, so the same work in different word forms matches: auditor and
 * audit, nursing and nurse, secretarial and secretary, accountant and accounting.
 * Found on real CVs (13 September), where exact words scored a Nursing Officer
 * zero against Registered Nurse.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suf of ["ational", "ation", "ing", "ial", "ary", "ant", "ance", "ence", "ist", "ers", "ors", "er", "or", "es", "s", "e", "y"]) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) { w = w.slice(0, -suf.length); break; }
  }
  return w;
}

const titleTokens = (v: string) =>
  v.toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1 && !STOP.has(t));

/** The same work under another name, as stems. */
const CORE_ALIASES: Record<string, string[]> = {
  procurement: ["purchas", "sourc", "buyer", "procure"],
  purchas: ["procurement", "sourc", "buyer"],
  account: ["financ", "audit", "bookkeep"],
  engineer: ["maintenance"],
  market: ["brand"],
  qualit: ["qa", "qc"],
  document: ["shipp", "export", "import", "customs"],
  suppl: ["logistic", "procurement", "purchas"],
  merchandis: ["merchandiser"],
  safet: ["hse", "ehs", "ohs", "shes"],
};

/** Words that sit in a title without naming the work. */
const WEAK_TITLE = new Set(["divisional", "regional", "country", "global", "industry", "from", "development", "operations", "business", "management", "sector", "company", "department", "division", "unit", "and", "the", "for", "with"]);

/**
 * The words in a job title that name the work — "pricing" in Senior Pricing
 * Manager, "supply chain" in Group Chief – Supply Chain — as stems. Someone
 * whose roles and skills show none of them is probably doing a different job
 * however close the rest of the CV reads (13 September: a Senior Pricing
 * Manager list had filled with heads of sales and brand managers).
 */
export function coreTermsOf(title: string): string[] {
  const words = titleTokens(title.replace(/\(.*?\)/g, " ")).filter((t) => !RANK_WORDS.has(t) && !WEAK_TITLE.has(t) && t.length > 2);
  return [...new Set(words.map(stem))].slice(0, 6);
}

/**
 * How close a title is to the job's, on the words that name the work.
 *
 * All of the job's role words present is 100; some is proportional. Sharing only
 * a rank word ("manager") is 20 — not nothing, but not the same job.
 */
export function titleScore(has: string | null, want: string, variants: string[]): number {
  if (!has) return 0;
  const mine = new Set(titleTokens(has).map(stem));
  if (mine.size === 0) return 0;

  let best = 0;
  for (const target of [want, ...variants]) {
    const words = titleTokens(target);
    const role = words.filter((t) => !RANK_WORDS.has(t)).map(stem);
    const rank = words.filter((t) => RANK_WORDS.has(t)).map(stem);
    if (role.length === 0) {
      if (rank.length) best = Math.max(best, Math.round((rank.filter((t) => mine.has(t)).length / rank.length) * 100));
      continue;
    }
    const roleHit = role.filter((t) => mine.has(t)).length;
    const score = roleHit > 0
      ? Math.round((roleHit / role.length) * 100)
      : rank.some((t) => mine.has(t)) ? 20 : 0;
    best = Math.max(best, score);
  }
  return best;
}

const NAMED_QUAL =
  /\b(ca|aca|fca|cima|acma|acca|fcca|cpa|cfa|mba|msc|m\.sc|bsc|b\.sc|beng|llb|mbbs|nebosh|iosh|cips|cipd|cim|pmp|six sigma|aat|cma|phd|hnd|acs|icsa)\b/i;

/** Soft skills a JD always asks for and a CV never lists the same way. Scored as noise, so dropped. */
const SOFT_SKILL = /communication|leadership|problem.?solving|analytical|team ?work|team player|time management|attention to detail|interpersonal|mentoring|adaptab|creativ|decision.?making|multi.?task|self.?motivat|organi[sz]ational|presentation skills|people skills|work ethic|reporting$/i;

/**
 * Which known skills a piece of text actually names.
 *
 * Longest first, so a JD mentioning "Trade Marketing" yields that rather than
 * the "Marketing" sitting inside it — the specific skill is the one that
 * separates candidates, and the generic one matches everybody.
 */
export function skillsFromText(text: string, known: string[]): string[] {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9&+#.\s]/g, " ").replace(/\s+/g, " ")} `;
  const out: string[] = [];
  for (const skill of [...new Set(known)].sort((a, b) => b.length - a.length)) {
    const n = skill.toLowerCase().trim();
    if (n.length < 3) continue;
    if (!hay.includes(` ${n} `) && !hay.includes(` ${n}s `) && !hay.includes(` ${n},`)) continue;
    // Skip anything already covered by a longer skill we took.
    if (out.some((taken) => taken.toLowerCase().includes(n))) continue;
    out.push(skill);
  }
  return out;
}

const MUST_STOP = new Set([
  "and","or","the","a","an","of","in","to","for","with","on","at","by","from","as","is","are",
  "be","proven","strong","relevant","excellent","good","ability","experience","skills","working",
  "knowledge","understanding","demonstrated","track","record","comparable","role","professional",
]);

/**
 * How well a candidate answers the JD's prose requirements.
 *
 * Word overlap against everything on the record — skills, title, employer,
 * industries and the career history — because a sentence like "Strong
 * stakeholder management" is not going to appear in a skills list and the
 * evidence for it, where there is any, is spread across the whole CV.
 *
 * Returns 70 where the JD asked nothing in prose: a neutral, not a zero. An
 * absent requirement must not look like a failed one.
 */
export function mustsScore(musts: string[], c: Candidate, cvText?: string | null): { score: number; met: string[]; contradicted: string[] } {
  if (musts.length === 0) return { score: 70, met: [], contradicted: [] };
  // Sentences that deny something are evidence against it, never for it:
  // "I have never managed procurement budgets" must not meet "Managed
  // procurement budgets" (13 September review).
  const sentences = (cvText ?? "").slice(0, 12000).split(/(?<=[.!?;\n])\s+|\n+/);
  const denied = sentences.filter((x) => NEGATED.test(x)).join(" ").toLowerCase();
  const hay = [
    sentences.filter((x) => !NEGATED.test(x)).join(" "),
    ...c.skills,
    c.currentTitle ?? "",
    c.currentEmployer ?? "",
    ...c.industries,
    ...c.workHistory.map((w) => `${w.title} ${w.employer}`),
    c.qualifications ?? "",
    c.educationDegree ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const met: string[] = [];
  const contradicted: string[] = [];
  const found = (text: string, w: string) => text.includes(w) || (stem(w).length >= 4 && text.includes(stem(w)));
  for (const m of musts) {
    const words = m
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !MUST_STOP.has(w));
    if (words.length === 0) continue;
    const hits = words.filter((w) => found(hay, w)).length;
    if (hits / words.length >= 0.5) met.push(m);
    else if (words.filter((w) => found(denied, w)).length / words.length >= 0.5) contradicted.push(m);
  }
  const scored = musts.filter((m) =>
    m.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).some((w) => w.length > 2 && !MUST_STOP.has(w)),
  );
  if (scored.length === 0) return { score: 70, met: [], contradicted: [] };
  return { score: Math.round((met.length / scored.length) * 100), met, contradicted };
}

/**
 * What a CV says about a credential: held, only part-way, or not mentioned.
 * "Currently studying CIMA", "ACCA – passed 9 papers", "CIMA Operational level"
 * are part-way, not qualified (13 September review: studying counted as held).
 * A record field (not free text) naming it counts as held.
 */
const PARTIAL = /\b(studying|student|pursuing|reading for|reading|in progress|ongoing|currently (?:following|doing|completing|studying)|part[- ]qualified|partly qualified|passed (?:\d+|all but)|papers?|stage|level|operational|management level|strategic level|foundation|certificate level|knowledge level|skills level|affiliate|enrolled|candidate|expected|awaiting|attempt\w*|completed \d+)\b/i;
const FULL = /\b(qualified|member|fellow|chartered|licentiate|ACMA|FCMA|CGMA|FCCA|FCA|ACA)\b/i;
export function credentialStatus(qual: string, recordFields: string, cvText: string): "held" | "partial" | "absent" {
  const q = qual.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`\\b${q}\\b`, "i");
  if (word.test(recordFields)) return "held";
  const text = cvText.replace(/\s+/g, " ");
  const re = new RegExp(`\\b${q}\\b`, "gi");
  let m: RegExpExecArray | null;
  let partial = false;
  while ((m = re.exec(text))) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + qual.length + 60);
    if (FULL.test(around) && !/\b(studying|student|pursuing|reading)\b/i.test(around)) return "held";
    if (PARTIAL.test(around)) partial = true;
    else return "held";
  }
  return partial ? "partial" : "absent";
}

const NEGATED = /\b(no|not|never|without|lack(?:ing|s)?|none|nil|hasn'?t|haven'?t|didn'?t|don'?t|doesn'?t|zero)\b/i;

/** Whether `phrase` appears in `text` as whole words. */
function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

export function skillsScore(required: string[], preferred: string[], has: string[]) {
  const mine = [...new Set(has.map(normSkill))];
  const mineStems = mine.map((m) => new Set(m.split(" ").map(stem)));
  const hit = (list: string[]) =>
    list.filter((s) => {
      const n = normSkill(s);
      // Whole words either way, so "advanced excel" covers "excel" — but a
      // plain substring let "javascript" satisfy "java" and "sapphire" satisfy
      // "sap" (audit finding 48).
      if (mine.some((m) => m === n || containsPhrase(m, n) || containsPhrase(n, m))) return true;
      // The same work in another word form — "Auditing" and "External Audit",
      // "Internal Controls" and "Internal Control". Every word of the skill has
      // to be there, stemmed, in one piece of evidence.
      const want = n.split(" ").filter((t) => t.length > 1).map(stem);
      return want.length > 0 && mineStems.some((m) => want.every((t) => m.has(t)));
    });

  const gotRequired = hit(required);
  const gotPreferred = hit(preferred);
  const missing = required.filter((s) => !gotRequired.includes(s));

  if (required.length === 0 && preferred.length === 0) {
    return { score: 70, matched: [] as string[], missing: [] as string[] };
  }
  const req = required.length ? gotRequired.length / required.length : 1;
  const pref = preferred.length ? gotPreferred.length / preferred.length : 0;
  const score = Math.round(Math.min(100, (required.length ? req * 80 : 0) + pref * 20 + (required.length ? 0 : 70)));
  return { score, matched: [...gotRequired, ...gotPreferred], missing };
}

export function experienceScore(years: number | null, min: number | null): number {
  if (min == null) return years == null ? 70 : Math.min(100, 60 + years * 3);
  if (years == null) return 55;
  if (years >= min) {
    // Well past the minimum is not better and can be worse.
    const over = years - min;
    return over > min * 1.5 ? 82 : 100;
  }
  const short = min - years;
  return Math.max(15, Math.round(100 - short * 18));
}

/** Years worked, from the career history, where the CV never states a total. */
export function yearsFromHistory(history: { fromYear: number; toYear: number | null }[], now = new Date().getFullYear()): number | null {
  const from = history.map((h) => h.fromYear).filter((y) => y > 1960 && y <= now);
  if (from.length === 0) return null;
  const to = Math.max(...history.map((h) => (h.toYear && h.toYear >= 1960 ? Math.min(h.toYear, now) : now)));
  return Math.max(0, to - Math.min(...from));
}

// ─── the whole ───────────────────────────────────────────────────────────────

export interface Breakdown {
  title: number;
  skills: number;
  seniority: number;
  experience: number;
  industry: number;
}

/**
 * The number shown on the database search and reverse-match screens —
 * boosted for how it reads, never for what anything decides.
 *
 * Requested 17 September: a real fit score in the 40s or 50s reads as "this
 * barely matches" even when the reasoning behind it is sound, and those two
 * screens are where a TA is skimming a long list rather than deciding one
 * candidate's fate. So the printed number is stretched upward — nothing else
 * changes. Ranking, the auto-shortlist bar, and every other screen (the
 * pipeline board, Director Review, the candidate's own Fit breakdown) keep
 * reading the real `score.overall`; this function is called only at the two
 * places that show it, and only for the headline number.
 *
 * A power curve, exponent 0.55: 0 still reads as 0, 100 still reads as 100,
 * and a higher real score always shows as a higher number — the order inside
 * a list never changes, only how generous the number looks. Low and middle
 * scores move the most (45 → 65, 60 → 76); a score already high barely moves
 * (80 → 88).
 */
export function exaggeratedScore(overall: number): number {
  const clamped = Math.min(100, Math.max(0, overall));
  return Math.round(100 * Math.pow(clamped / 100, 0.55));
}

/** The band word, worked out from a displayed number rather than the real one —
 *  so a boosted number is never shown next to a word that contradicts it. */
export function bandFor(overall: number): Score["band"] {
  return overall >= FIT_BANDS.strong ? "strong" : overall >= FIT_BANDS.worth ? "worth a look" : "weak";
}

export interface Score {
  overall: number;
  band: "strong" | "worth a look" | "weak";
  breakdown: Breakdown;
  weights: Weights;
  /** Why the number is what it is, in order of how much each cost. */
  reasons: string[];
  matchedSkills: string[];
  missingSkills: string[];
  /** Applied after the blend, each with what it took off. */
  penalties: { label: string; delta: number }[];
  /** True when the whole set was scored with semantic recall folded in. */
  semanticUsed: boolean;
  /**
   * The whole working, line by line: what was compared, what each part scored,
   * how much it weighs for this kind of job, and the points it put in. The
   * lines add up to the number before penalties; the penalties follow. A TA
   * reading this can see exactly why somebody got 64 and not 80.
   */
  explanation: ExplainLine[];
}

export interface ExplainLine {
  part: "Title" | "Skills" | "Seniority" | "Experience" | "Industry" | "Penalty" | "Semantic";
  /** 0–100, where the part is scored. Null for a penalty. */
  score: number | null;
  /** Share of the total, 0–1. Null for a penalty. */
  weight: number | null;
  /** What it put into (or took off) the total. */
  points: number;
  /** The evidence, in words. */
  detail: string;
}

export interface ScoreOptions {
  /** 0–1. Only used when every candidate in the set has one. */
  vector?: number;
  /**
   * The CV's own text. Live records carry no qualifications field at all, so
   * "ACCA" is only ever in the CV; without this every ACCA holder was marked
   * missing it (13 September).
   */
  cvText?: string | null;
  weightOverride?: Partial<Weights>;
}

export function scoreCandidate(
  c: Candidate,
  req: Requirements,
  opts: ScoreOptions = {},
): Score {
  const w = weightsFor(req, opts.weightOverride);

  // The current title, or failing that the last few jobs — a CV whose top line
  // was not read still has a career under it.
  const title = Math.max(
    titleScore(c.currentTitle, req.title, req.titleVariants),
    ...c.workHistory.slice(0, 3).map((h, i) => Math.round(titleScore(h.title, req.title, req.titleVariants) * (i === 0 ? 0.95 : 0.8))),
  );
  // Evidence for a skill is anywhere on the record, not only the skills list:
  // an auditor's CV shows "Internal Control" in a job title or history as
  // often as in a list of skills.
  const titleNow = c.currentTitle || c.workHistory[0]?.title || null;
  const evidence = [
    ...c.skills,
    ...(titleNow ? [titleNow] : []),
    ...c.workHistory.slice(0, 6).map((h) => h.title),
    c.qualifications ?? "",
    c.educationDegree ?? "",
    ...c.industries,
  ].filter(Boolean);
  const cvNorm = opts.cvText ? ` ${norm(opts.cvText)} ` : "";
  if (cvNorm) {
    for (const s of [...req.requiredSkills, ...req.preferredSkills]) {
      if (cvNorm.includes(` ${norm(s)} `)) evidence.push(s);
    }
  }
  const named = skillsScore(req.requiredSkills, req.preferredSkills, evidence);
  const musts = mustsScore(req.qualitativeMusts ?? [], c, opts.cvText);

  /*
   * The "skills" component is both halves of what a JD asks for: the skills it
   * names, and the things it describes in prose. Weighted towards the named
   * ones, because those are evidence and the prose ones are an inference.
   *
   * Where the JD names no skills at all — which happens on a thin JD — the
   * prose carries it alone rather than scoring everyone zero.
   */
  const hasNamed = req.requiredSkills.length > 0 || req.preferredSkills.length > 0;
  const hasMusts = (req.qualitativeMusts ?? []).length > 0;
  const skills = {
    score: hasNamed && hasMusts
      ? Math.round(named.score * 0.7 + musts.score * 0.3)
      : hasNamed
        ? named.score
        : hasMusts
          ? musts.score
          : 70,
    matched: [...named.matched, ...musts.met],
    missing: named.missing,
  };
  const has = seniorityOf(`${c.currentTitle || c.workHistory[0]?.title || ""}`) ?? null;
  const seniority = seniorityScore(req.seniority, has);
  // The longer of the stated total and the career history: parsed totals run low.
  const fromHistory = yearsFromHistory(c.workHistory);
  const years = c.totalExperienceYears == null ? fromHistory : Math.max(c.totalExperienceYears, fromHistory ?? 0);
  const experience = experienceScore(years, req.minYears);
  // Industry is where they worked, job by job — worked out from each employer
  // when the record does not say, which on live data it almost never does.
  // A digital marketer at MAS keeps their field and gains apparel experience.
  const worked = industryExperience(c);
  // Apparel, food and pharma factories are manufacturing: a JD asking for a
  // manufacturing background is answered by any of them (13 September: Emjay's
  // senior procurement manager was marked as having none).
  const MAKES = new Set(["Manufacturing", "Apparel & Textile", "FMCG & Food", "Healthcare & Pharma"]);
  const wantedIndustry = (i: string) => req.industries.some((r) => {
    const a = normaliseIndustry(i) ?? i, b = normaliseIndustry(r) ?? r;
    if (b === "Manufacturing" && MAKES.has(a)) return true;
    return norm(a) === norm(b) || norm(i).includes(norm(r)) || norm(r).includes(norm(i));
  });
  const inWanted = worked.filter((x) => wantedIndustry(x.industry));
  const industry =
    req.industries.length === 0
      ? 70
      : inWanted.length
        ? Math.min(100, 75 + Math.round(inWanted.reduce((n, x) => n + x.years, 0) * 5))
        : worked.length === 0 ? 60 : 40;

  const breakdown: Breakdown = { title, skills: skills.score, seniority, experience, industry };

  let overall = Math.round(
    title * w.title + skills.score * w.skills + seniority * w.seniority +
    experience * w.experience + industry * w.industry,
  );

  const penalties: { label: string; delta: number }[] = [];
  // A penalty lowers the score towards its floor and never past it — and never
  // raises it. The old form, max(floor, score + delta), lifted a score already
  // below the floor, so adding a missing qualification to a candidate who was
  // already sunk moved them UP (audit finding 50).
  const take = (label: string, delta: number, floor: number) => {
    const before = overall;
    overall = Math.min(before, Math.max(floor, before + delta));
    if (overall !== before) penalties.push({ label, delta: overall - before });
  };

  // Nothing in common on either the words or the work. The original forced 0;
  // a floor keeps them last but visible, which is where a career changer should
  // sit rather than deleted.
  if (title === 0 && skills.score === 0) {
    take("Nothing matches on title or skills", 12 - overall, 0);
  } else if (req.requiredSkills.length > 0 && skills.matched.length === 0 && title < 40) {
    take("None of the required skills, and a weak title", -Math.round(overall * 0.6), 10);
  }

  // Country against city is the commonest shape here — a Colombo role and a
  // Kurunegala candidate are both Sri Lanka, and a naive string test would
  // penalise every local candidate on a local job. See lib/places.
  // Location ranks, it does not exclude (13 September): the desk sends Sri
  // Lankans to Dhaka and Riyadh, and a blank location is thin data, not a
  // reason. Only a JD that says local candidates only makes another country a
  // real cost — and there only the country counts, never the city.
  const fit = locationFit(req.locations, c.location);
  if (fit === "mismatch" && req.localOnly) take("Based in another country — local candidates only", -30, 5);
  else if (fit === "mismatch") take(`Based outside ${req.locations.join(" or ")}`, -10, 5);
  else if (fit === "same_country" && !req.localOnly) take("A different city, same country", -4, 20);

  // Where a client states a nationality it is a requirement, not a preference.
  if (req.nationalities.length > 0 && c.nationality) {
    const ok = req.nationalities.some((n) => norm(c.nationality!).includes(norm(n)));
    if (!ok) take(`${req.nationalities.join(" or ")} only`, -45, 2);
  }
  // A guessed nationality never affects ranking (13 September review): only a
  // stated or verified one counts. Guesses from schooling, phone or employers
  // wrongly push good people down and are not a fair basis for suitability.

  if (req.managementYears) {
    const LEAD = /\b(manager|head|lead|director|chief|gm|agm|dgm|general manager|supervisor|controller|superintendent|principal)\b/i;
    const now = new Date().getFullYear();
    const led = c.workHistory.filter((h) => h.fromYear && LEAD.test(h.title) && !/\b(assistant to|executive assistant)\b/i.test(h.title))
      .reduce((n, h) => n + Math.max(0, (h.toYear ?? now) - h.fromYear), 0);
    // No dated history is unknown, not a failure: nothing is taken off.
    if (c.workHistory.some((h) => h.fromYear) && led < req.managementYears) {
      take(`About ${led} years in management roles; the JD asks for ${req.managementYears}`, led === 0 ? -15 : -8, 15);
    }
  }

  if (musts.contradicted.length > 0) {
    take(`CV says otherwise: ${musts.contradicted.slice(0, 2).join("; ")}`, -15, 10);
  }

  // Two or more levels apart is a different job, not a close one (13 September:
  // heads of marketing filled a Marketing Executive list, and supply chain
  // executives a Group Chief one). Ranked well down, never removed.
  if (req.seniority && has) {
    const gap = RANKS[has] - RANKS[req.seniority];
    if (gap >= 2) take(`Well above the level of this role (${has} for ${req.seniority})`, -15, 10);
    else if (gap <= -2) take(`Well below the level of this role (${has} for ${req.seniority})`, -15, 10);
    // One step either way is a stretch, not a mismatch: a small nudge so the
    // right level ranks first (senior executives outranked managers for a
    // Procurement Manager role).
    else if (gap !== 0) take(`One level ${gap > 0 ? "above" : "below"} this role`, -6, 20);
  }

  // A software title is not the work of a plant, civil or mechanical role that
  // happens to share the word "engineer" (13 September, Head of Engineering).
  const SOFTWARE = /\b(software|developer|devops|front ?end|back ?end|full ?stack|qa engineer|test(?:ing)? engineer|data (?:engineer|scientist)|mobile|ios|android|web|cloud|machine learning|ai engineer)\b/i;
  const recentTitles = [c.currentTitle ?? "", ...c.workHistory.slice(0, 2).map((h) => h.title)].filter(Boolean);
  if (!SOFTWARE.test(req.title) && recentTitles.length > 0 && recentTitles.every((t) => SOFTWARE.test(t))) {
    take("A software role — this job is not", -25, 10);
  }

  // None of the title's work words anywhere in their roles or skills: ranked
  // well down, never removed — a TA can still find them below the bar.
  const core = req.coreTerms ?? [];
  if (core.length > 0) {
    const theirs = new Set(
      [c.currentTitle ?? "", ...c.workHistory.slice(0, 5).map((h) => h.title), ...c.skills]
        .join(" ").toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean).map(stem),
    );
    if (!core.some((t) => theirs.has(t) || (CORE_ALIASES[t] ?? []).some((x) => theirs.has(x)))) take(`Nothing in their roles or skills says ${req.title}`, -25, 10);
  }

  if (req.industryRequired && req.industries.length > 0 && worked.length > 0 && inWanted.length === 0) {
    take(`No ${req.industries.join(" or ")} experience found — the JD asks for it`, -15, 10);
  }

  if (req.requiredQualifications.length > 0) {
    // Each requirement is a set of alternatives — "CA|ACCA|CIMA" — and every
    // requirement needs one of its alternatives held, as a whole word. The JD
    // sentence itself is never matched: "CIMA qualified" is not in a record
    // that says "CIMA" (audit finding 46).
    const record = `${c.qualifications ?? ""} ${c.educationDegree ?? ""}`;
    const statusOf = (group: string) => {
      const st = group.split("|").map((q) => credentialStatus(q, record, opts.cvText ?? ""));
      return st.includes("held") ? "held" : st.includes("partial") ? "partial" : "absent";
    };
    const partial = req.requiredQualifications.filter((g) => statusOf(g) === "partial");
    const unmet = req.requiredQualifications.filter((g) => statusOf(g) === "absent");
    if (unmet.length > 0) {
      take(`Missing ${unmet.map((g) => g.split("|").join(" or ")).join(", ")}`, -20, 10);
    }
    if (partial.length > 0) {
      take(`${partial.map((g) => g.split("|")[0]).join(", ")} part-way, not yet qualified`, -12, 15);
    }
  }

  // A preferred credential lifts the score a little. Applied as a bonus, not
  // a penalty, so not having one never marks anybody down.
  const preferredQ = req.preferredQualifications ?? [];
  if (preferredQ.length > 0) {
    const record = `${c.qualifications ?? ""} ${c.educationDegree ?? ""}`;
    const alias: Record<string, string[]> = { ACA: ["ACA", "FCA", "CA"], CA: ["CA", "ACA", "FCA"], ACCA: ["ACCA", "FCCA"], CIMA: ["CIMA", "ACMA"], CPA: ["CPA"] };
    const got = preferredQ.find((q) => (alias[q] ?? [q]).some((a) => credentialStatus(a, record, opts.cvText ?? "") === "held"));
    if (got) {
      const before = overall;
      overall = Math.min(100, overall + 6);
      if (overall !== before) penalties.push({ label: `Holds ${got}, which the JD prefers`, delta: overall - before });
    }
  }

  if (req.negativeKeywords.length > 0) {
    const hay = norm(`${c.currentTitle ?? ""} ${c.skills.join(" ")} ${c.industries.join(" ")}`);
    const hit = req.negativeKeywords.find((k) => hay.includes(norm(k)));
    if (hit) take(`Ruled out before: ${hit}`, -30, 5);
  }

  // Decided once for the whole set by the caller — see scoreSet.
  // Similarity finds people; it does not decide suitability. Blending 40% of it
  // into the score softened real mismatches and made the same person score
  // differently on different screens (13 September review). One assessment,
  // everywhere: similarity is kept for ordering candidates in retrieval only.
  const semanticUsed = false;
  const beforeSemantic = overall;

  overall = Math.max(0, Math.min(100, overall));

  const reasons: string[] = [];
  const parts: [string, number, number][] = [
    ["Title", title, w.title],
    ["Skills", skills.score, w.skills],
    ["Seniority", seniority, w.seniority],
    ["Experience", experience, w.experience],
  ];
  // Weakest contribution first, so the reason that cost the most is the one a
  // TA reads before deciding whether to bother.
  const ordered = [...parts].sort((a, b) => a[1] * a[2] - b[1] * b[2]);
  for (const [label, value, weight] of ordered) {
    if (value >= 85) reasons.push(`${label} is a strong match.`);
    else if (value >= 60) reasons.push(`${label} is close.`);
    else if (weight > 0.15) reasons.push(`${label} is where this falls down.`);
  }
  if (skills.missing.length) {
    reasons.push(`No sign of ${skills.missing.slice(0, 3).join(", ")}.`);
  }

  const explanation = explain({
    c: { ...c, totalExperienceYears: years }, req, w, title, skills, named, musts, seniority, has, experience, industry, penalties,
    semanticUsed, beforeSemantic, overall, fit,
  });

  return {
    explanation,
    overall,
    band: overall >= FIT_BANDS.strong ? "strong" : overall >= FIT_BANDS.worth ? "worth a look" : "weak",
    breakdown,
    weights: w,
    reasons: reasons.slice(0, 4),
    matchedSkills: skills.matched,
    missingSkills: skills.missing,
    penalties,
    semanticUsed,
  };
}

const SENIORITY_WORD: Record<Seniority, string> = {
  intern: "intern", junior: "junior", mid: "mid-level", senior: "senior", lead: "manager / lead", executive: "director / executive",
};

/** Builds the line-by-line working for `Score.explanation`. */
function explain(x: {
  c: Candidate; req: Requirements; w: Weights; title: number;
  skills: { score: number; matched: string[]; missing: string[] };
  named: { score: number; matched: string[]; missing: string[] };
  musts: { score: number; met: string[] };
  seniority: number; has: Seniority | null; experience: number; industry: number;
  penalties: { label: string; delta: number }[];
  semanticUsed: boolean; beforeSemantic: number; overall: number; fit: string;
}): ExplainLine[] {
  const { c, req, w } = x;
  const pts = (score: number, weight: number) => Math.round(score * weight);
  const words = (v: string) => norm(v).split(" ").filter((t) => t.length > 2 && !STOP.has(t));
  const mineWords = new Set(words(c.currentTitle ?? ""));
  const shared = [...new Set([req.title, ...req.titleVariants].flatMap(words))].filter((t) => mineWords.has(t));

  const out: ExplainLine[] = [
    {
      part: "Title",
      score: x.title,
      weight: w.title,
      points: pts(x.title, w.title),
      detail: !c.currentTitle
        ? "No current title on the record."
        : shared.length
          ? `“${c.currentTitle}” against “${req.title}” — shares ${shared.map((t) => `“${t}”`).join(", ")}.`
          : `“${c.currentTitle}” shares no words with “${req.title}”.`,
    },
    {
      part: "Skills",
      score: x.skills.score,
      weight: w.skills,
      points: pts(x.skills.score, w.skills),
      detail: [
        req.requiredSkills.length
          ? `Required: has ${x.named.matched.filter((m) => req.requiredSkills.includes(m)).length} of ${req.requiredSkills.length}` +
            (x.named.missing.length ? ` (missing ${x.named.missing.join(", ")})` : "") + "."
          : "The JD names no required skills.",
        req.preferredSkills.length
          ? `Preferred: has ${x.named.matched.filter((m) => req.preferredSkills.includes(m)).length} of ${req.preferredSkills.length}.`
          : "",
        (req.qualitativeMusts ?? []).length
          ? `Written requirements: evidence for ${x.musts.met.length} of ${(req.qualitativeMusts ?? []).length}` +
            (x.musts.met.length ? ` — ${x.musts.met.slice(0, 3).map((m) => `“${m}”`).join(", ")}` : "") + "."
          : "",
      ].filter(Boolean).join(" "),
    },
    {
      part: "Seniority",
      score: x.seniority,
      weight: w.seniority,
      points: pts(x.seniority, w.seniority),
      detail: !req.seniority
        ? "The job title does not say a level."
        : !x.has
          ? `The role is ${SENIORITY_WORD[req.seniority]}; the candidate's title does not say a level.`
          : x.has === req.seniority
            ? `Both ${SENIORITY_WORD[req.seniority]}.`
            : RANKS[x.has] > RANKS[req.seniority]
              ? `Candidate is ${SENIORITY_WORD[x.has]}, the role is ${SENIORITY_WORD[req.seniority]} — too senior costs more than too junior.`
              : `Candidate is ${SENIORITY_WORD[x.has]}, the role is ${SENIORITY_WORD[req.seniority]}.`,
    },
    {
      part: "Experience",
      score: x.experience,
      weight: w.experience,
      points: pts(x.experience, w.experience),
      detail:
        c.totalExperienceYears == null
          ? "Years of experience not on the record."
          : req.minYears == null
            ? `${c.totalExperienceYears} years; the JD sets no minimum.`
            : c.totalExperienceYears >= req.minYears
              ? `${c.totalExperienceYears} years against a minimum of ${req.minYears}.`
              : `${c.totalExperienceYears} years — ${req.minYears - c.totalExperienceYears} short of the ${req.minYears} asked for.`,
    },
  ];
  if (w.industry > 0) {
    out.push({
      part: "Industry",
      score: x.industry,
      weight: w.industry,
      points: pts(x.industry, w.industry),
      detail: req.industries.length === 0
        ? "No industry stated for the job."
        : x.industry === 100
          ? `Has worked in ${req.industries.join(" / ")}.`
          : `No ${req.industries.join(" / ")} background on the record${c.industries.length ? ` (has ${c.industries.slice(0, 3).join(", ")})` : ""}.`,
    });
  }
  // Rounding each part separately can leave the lines a point off the total.
  // The difference goes on the heaviest part, so the working always adds up.
  const blended = x.beforeSemantic - x.penalties.reduce((n, p) => n + p.delta, 0);
  const drift = blended - out.reduce((n, l) => n + l.points, 0);
  if (drift !== 0) {
    const heaviest = out.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a));
    heaviest.points += drift;
  }
  for (const p of x.penalties) {
    out.push({ part: "Penalty", score: null, weight: null, points: p.delta, detail: p.label });
  }
  if (x.semanticUsed) {
    out.push({
      part: "Semantic",
      score: null,
      weight: 0.4,
      points: x.overall - x.beforeSemantic,
      detail: "Blended 60/40 with how closely the whole CV reads like the JD.",
    });
  }
  return out;
}

/**
 * A whole set, on one scale.
 *
 * This is the function callers should use. It decides the semantic question
 * once: if every candidate has a vector the blend is applied to all of them,
 * and if any is missing one it is applied to none — because two candidates in
 * the same ranked list scored on different scales is not a ranking.
 */
export function scoreSet(
  rows: { candidate: Candidate; vector?: number; cvText?: string | null }[],
  req: Requirements,
  weightOverride?: Partial<Weights>,
): { candidate: Candidate; score: Score }[] {
  const allHaveVectors = rows.length > 0 && rows.every((r) => typeof r.vector === "number");
  return rows
    .map((r) => ({
      candidate: r.candidate,
      score: scoreCandidate(r.candidate, req, {
        vector: allHaveVectors ? r.vector : undefined,
        cvText: r.cvText,
        weightOverride,
      }),
    }))
    .sort((a, b) => b.score.overall - a.score.overall);
}
// ─── from an opening ─────────────────────────────────────────────────────────

/** Rough discipline from the words the desk already uses. Overridable per
 *  opening once that is worth a field. */
export function disciplineOf(title: string, industries: string[]): Discipline {
  const t = norm(`${title} ${industries.join(" ")}`);
  if (/\bfinanc|account|audit|treasur|tax\b/.test(t)) return "finance";
  if (/\bengineer|developer|software|technical|mechanic|electric\b/.test(t)) return "engineering";
  if (/\bdesign|creative|graphic|fashion|merchandis\b/.test(t)) return "design";
  if (/\bsales|business development|brand|marketing|account manager\b/.test(t)) return "sales";
  if (/\bhr\b|human resource|talent|recruit|people\b/.test(t)) return "hr";
  if (/\boperation|supply chain|logistic|production|warehouse|procurement\b/.test(t)) return "operations";
  return "general";
}

/**
 * A plain-text JD as Markdown bullets. Headings — short lines in capitals, or
 * ending in a colon, or standing alone — become headings; every other line
 * becomes a bullet. A JD that already has bullets is left as it is.
 */
export function asBullets(jd: string): string {
  const lines = jd.split("\n");
  const bulleted = lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length;
  if (bulleted >= 1) return jd;
  const out: string[] = [];
  lines.forEach((raw) => {
    const l = raw.trim();
    if (!l) return void out.push("");
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(raw) || /^#{1,6}\s/.test(l)) return void out.push(raw);
    const words = l.split(/\s+/);
    const hasYears = /\d+\s*\+?\s*years?/i.test(l);
    // "Strategic Pricing", "Process Design & Modelling": every word capitalised.
    const titleCase = words.length <= 6 && words.every((w) => /^(?:[A-Z0-9&/(–-]|and$|of$|the$|in$|for$|to$|with$|&$)/.test(w));
    const heading = !hasYears && l.length <= 60 && !/[.;,]$/.test(l) && (
      (l === l.toUpperCase() && /[A-Z]/.test(l)) || /:$/.test(l) || titleCase
    );
    out.push(heading ? `## ${l.replace(/:$/, "")}` : `- ${l}`);
  });
  return out.join("\n");
}

/** Splits a JD at its "preferred / desirable / nice to have" heading, if it has one. */
function preferredSplit(jd: string): string[] {
  return jd.split(
    /^\s*(?:#{1,6}\s*)?[*_]*\s*(?:desirable|preferred|prefer:?|nice[- ]to[- ]haves?|advantageous|an advantage|bonus|good to have)\b[^\n]{0,40}$/im,
  );
}

/**
 * The requirements, read off the opening and its approved JD.
 *
 * The JD is already written and already approved, so nothing here is retyped —
 * the bullets under a "requirements" heading are the requirements, and the
 * package, locations and nationality come off the opening record.
 */
export function requirementsFromOpening(input: {
  title: string;
  jdMarkdown: string;
  locations: string[];
  targetNationalities: string[];
  industry: string | null;
  negativeKeywords?: string[];
  /** The skills the database actually knows about — repo.vocabulary().skills.
   *  Without it there is nothing to match a JD's wording against. */
  knownSkills?: string[];
  /**
   * The Job details a TA reviewed (or the extractor read from the approved
   * JD). Where a field is set it wins over what the JD text is parsed into:
   * a person checked it, and the parser can only guess from wording.
   */
  structured?: {
    requiredSkills?: string[];
    niceToHaveSkills?: string[];
    experienceMinYears?: number | null;
    seniorityLevel?: string | null;
    location?: string | null;
  };
}): Requirements {
  const base = requirementsFromJdText(input);
  const s = input.structured;
  if (!s) return base;
  const required = (s.requiredSkills ?? []).filter(Boolean);
  const preferred = (s.niceToHaveSkills ?? []).filter((p) => !required.some((r) => r.toLowerCase() === p.toLowerCase()));
  const seniority = seniorityFromLevel(s.seniorityLevel);
  return {
    ...base,
    requiredSkills: required.length ? required.slice(0, 12) : base.requiredSkills,
    preferredSkills: required.length || preferred.length ? preferred.slice(0, 10) : base.preferredSkills,
    // The creation placeholder (2 years, mid-level) is not a requirement anyone read.
    minYears: typeof s.experienceMinYears === "number" && s.experienceMinYears > 0 ? s.experienceMinYears : base.minYears,
    seniority: seniority ?? base.seniority,
    locations: s.location && !base.locations.length ? [s.location] : base.locations,
  };
}

/** The backend's eleven job levels onto this scorer's six. */
export function seniorityFromLevel(level: string | null | undefined): Seniority | null {
  switch (level) {
    case "entry_level": return "junior";
    case "mid_level": return "mid";
    case "executive": return "mid";
    case "senior_executive": return "senior";
    case "manager": case "senior_manager": case "agm": return "lead";
    case "gm": case "director": case "c_suite": return "executive";
    default: return null;
  }
}

function requirementsFromJdText(input: {
  title: string;
  jdMarkdown: string;
  locations: string[];
  targetNationalities: string[];
  industry: string | null;
  negativeKeywords?: string[];
  knownSkills?: string[];
}): Requirements {
  // Most JDs pasted from elsewhere have no bullet markers at all — plain lines
  // under headings. Read those as bullets, or nothing is found (13 September:
  // 9 of 12 live JDs gave no skills, years or qualifications).
  const jd = asBullets(input.jdMarkdown);
  const bulletsOf = (text: string) =>
    text
      .split("\n")
      .filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l))
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
      .filter(Boolean);
  const bullets = bulletsOf(jd);

  // "Minimum 8–10 years" and "5+ years" are both a floor.
  // The lowest floor the JD states, not the first: "15 years overall, 8 in
  // management" and a job record saying 5 under a JD saying "8–10" both mean
  // someone with 8 or 5 is in scope (13 September: the first-found figure
  // removed good people).
  // Each experience requirement keeps its scope (13 September review): "15 years
  // overall, 8 in management" is a 15-year floor AND an 8-year management floor,
  // not an 8-year floor. Where two sources state different overall floors (the
  // JD and the job record), the lower one applies so nobody is removed on a
  // disagreement between our own documents.
  const floorsOf = (b: string) => {
    const ms = [...b.matchAll(/(\d{1,2})\s*(?:–|-|to)?\s*(?:\d{1,2})?\s*\+?\s*years?/gi)];
    // Each figure's scope is the words after it, up to the next figure.
    return ms
      .map((m, i) => ({ n: Number(m[1]), scope: b.slice(m.index! + m[0].length, ms[i + 1]?.index ?? m.index! + m[0].length + 60) }))
      .filter((f) => f.n > 0 && f.n <= 30);
  };
  // "Procurement management" names the work; "managerial role", "in management",
  // "leading teams" name the leadership floor.
  const MGMT = /\b(managerial|leadership|leading (?:a )?teams?|people management|team management|managing (?:a )?teams?|in (?:a )?management|supervisory|head of)\b/i;
  const allFloors = bullets.flatMap((b) => {
    const fs = floorsOf(b);
    // "15 years of experience, of which 8 in management": first is overall, the rest scoped by their own words.
    return fs.map((f) => ({ n: f.n, management: MGMT.test(f.scope.slice(0, 60)) || (fs.length === 1 && MGMT.test(b)) }));
  });
  const overallFloors = allFloors.filter((f) => !f.management).map((f) => f.n);
  const managementFloors = allFloors.filter((f) => f.management).map((f) => f.n);
  const years = overallFloors.length ? Math.min(...overallFloors) : managementFloors.length ? null : null;
  const managementYears = managementFloors.length ? Math.max(...managementFloors) : null;

  /*
   * Only a NAMED qualification counts.
   *
   * The old test matched the word "qualification" itself, so a JD bullet
   * reading "Relevant professional qualification" — which is boilerplate on
   * every JD this desk writes — took twenty points off every candidate alive.
   * A penalty that applies to everybody is not a penalty, it is a constant.
   */
  const quals = (preferredSplit(jd)[0] === jd ? bullets : bulletsOf(preferredSplit(jd)[0]))
    // "Diploma or BSc in Nursing" names one credential and allows another it
    // does not name — so nobody should be marked down for lacking the BSc.
    .filter((b) => !(/\bor\b/i.test(b) && /\b(diploma|degree|bachelor|equivalent|certificate)\b/i.test(b)))
    .map((b) => [...b.matchAll(new RegExp(NAMED_QUAL.source, "gi"))].map((m) => m[1].toUpperCase()))
    .filter((names) => names.length > 0)
    .map((names) => [...new Set(names.flatMap((n) => (n === "CA" ? ["CA", "ACA", "FCA"] : n === "ACCA" ? ["ACCA", "FCCA"] : n === "CIMA" ? ["CIMA", "ACMA"] : [n])))].join("|"));

  /*
   * Skills are read against the vocabulary the database actually holds, not
   * guessed from bullet length. A JD asking for "Trade Marketing" can be
   * matched; a JD asking for "Strong stakeholder management" cannot, and
   * pretending otherwise scores everyone zero.
   */
  const known = input.knownSkills ?? [];

  /*
   * A JD has two lists, and treating them the same wastes the difference.
   * Anything under a "desirable" or "nice to have" heading is preferred, not
   * required — it should lift a candidate who has it without failing one who
   * does not.
   */
  // Any common heading form: "## Preferred", "**Desirable:**", "Nice to have",
  // "Preferred skills:". A Markdown "## Preferred" used to be missed, which
  // made every nice-to-have a requirement (audit finding 47).
  const split = preferredSplit(jd);
  const beforePreferred = split[0];
  const preferredQuals = split.length > 1
    ? [...new Set(bulletsOf(split.slice(1).join("\n")).flatMap((b) => [...b.matchAll(new RegExp(NAMED_QUAL.source, "gi"))].map((m) => m[1].toUpperCase())))]
    : [];
  const preferredText = split.length > 1 ? split.slice(1).join("\n") : "";

  /*
   * A JD's responsibilities are what the person will do, not what they must
   * already have. Where the JD has a requirements heading, skills are read from
   * under it only; reading the duties too turned "meeting with management" and
   * "reporting" into required skills nobody's CV lists (13 September, real CVs).
   */
  const reqHeading = /^\s*(?:#{1,6}\s*)?[*_]*\s*(?:(?:key |minimum |job |experience |essential )?requirements?|qualifications?|essential|must[- ]haves?|what you (?:need|bring|have)|skills (?:and|&) experience|about you|(?:ideal )?candidate profile|(?:the )?ideal candidate|who (?:we are|we're) looking for|what we(?:'re| are) looking for|experience (?:and|&) qualifications?|education(?: (?:and|&) experience)?|technical (?:competenc|skills)\w*|competenc\w*)\b[^\n]{0,40}$/im;
  const reqAt = beforePreferred.search(reqHeading);
  const requiredText = reqAt >= 0 ? beforePreferred.slice(reqAt) : beforePreferred;
  const notSoft = (sk: string) => !SOFT_SKILL.test(sk);

  const skills = skillsFromText(requiredText, known).filter(notSoft);
  const preferred = skillsFromText(preferredText, known).filter(notSoft).filter((p) => !skills.includes(p));

  // Whatever the JD asked for that named no known skill, kept as prose.
  const requiredBullets = bulletsOf(requiredText);
  const musts = requiredBullets
    .filter((b) => b.length <= 90 && !/\byears?\b/i.test(b) && !NAMED_QUAL.test(b))
    .filter((b) => !skills.some((sk) => b.toLowerCase().includes(sk.toLowerCase())))
    .filter((b) => !SOFT_SKILL.test(b) || b.split(/\s+/).length > 6)
    .map((b) => b.replace(/\.$/, ""));

  const wantedIndustry = industryWanted(jd, input.industry);
  return {
    title: input.title,
    titleVariants: [],
    requiredSkills: skills.slice(0, 10),
    qualitativeMusts: musts.slice(0, 6),
    preferredSkills: preferred.slice(0, 8),
    minYears: years,
    managementYears,
    // "Senior Executive / Assistant Accountant" is open to both: take the higher.
    seniority: input.title.split("/").map((p) => seniorityOf(p)).filter((x): x is Seniority => Boolean(x)).sort((x, y) => RANKS[y] - RANKS[x])[0] ?? null,
    locations: input.locations,
    localOnly: localOnlyFromJd(jd),
    nationalities: input.targetNationalities,
    industries: wantedIndustry ? [wantedIndustry.industry] : input.industry ? [input.industry] : [],
    industryRequired: wantedIndustry?.required ?? false,
    coreTerms: coreTermsOf(input.title),
    requiredQualifications: quals.slice(0, 4),
    preferredQualifications: preferredQuals.slice(0, 4),
    negativeKeywords: input.negativeKeywords ?? [],
    discipline: disciplineOf(input.title, input.industry ? [input.industry] : []),
  };
}
