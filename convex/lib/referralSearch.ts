// convex/lib/referralSearch.ts
//
// Referral Search, the parts that need no database and no model (8 Oct).
//
// A TA types "HR managers at Dialog" or "contact details of referees from retail
// companies". A model turns that into a title list and a company list; the
// backend finds referees by those words; this file decides who matches, in what
// order, and which rows are one person named by several candidates. Pure, so it
// is tested.
//
// What the data is: ~33,000 referees read off CVs. A designation can be years
// old, a company can be spelled three ways, and the same HR manager is named by
// every candidate who worked under them. The rules below follow from that.

import { jsonIn } from "./claudeFirst";

export type ReferralCriteria = {
  /** Job titles asked for. The first is what was typed; the rest are equivalents (Head of HR). */
  designations: string[];
  /** Companies asked for. The first is what was typed; the rest are variants or an industry's known names. */
  companies: string[];
  /** A person's name, when the search is for someone in particular. */
  name: string | null;
  /** One word with no clue what it is — searched as a title, a company and a name. */
  loose: string | null;
  /** The sentence asked for phone numbers or emails: referees with neither are left out. */
  needsContact: boolean;
  industry: string | null;
  /** One line for the "Searching for" chip. */
  summary: string;
};

export const MAX_TERMS = 8;

export const REFERRAL_SYSTEM = `You read a recruiter's search for REFEREES (people named on candidates' CVs as references) at Sri Lankan and regional companies.
Return ONLY JSON:
{
  "designations": ["job title asked for, then genuinely equivalent titles a CV would use (max 6)"],
  "companies": ["company asked for, then its common spellings/parent names (max 8)"],
  "name": "a person's name if the search is for one person, else null",
  "needsContact": true if they ask for phone numbers, emails or contact details,
  "industry": "industry if they name one (retail, FMCG, telecom, banking...), else null",
  "summary": "one short line: what is being searched, e.g. HR Managers · Dialog"
}
Rules:
- Only what was asked. A company search has empty designations; a title search has empty companies.
- Expand abbreviations: GM = General Manager, HR = Human Resources, CEO = Chief Executive Officer. Keep the short form too ("HR Manager" and "Human Resources Manager").
- For an industry with no company named, put well-known companies of that industry in "companies" (Sri Lanka first), up to 8, and also the industry word itself when companies might be named after it (e.g. "Stores", "Supermarket").
- Never invent people or contact details.`;

export function referralPrompt(text: string): string {
  return `Search: ${text.slice(0, 500)}`;
}

const arr = (x: unknown, max: number): string[] =>
  Array.isArray(x)
    ? [...new Set(x.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean))].slice(0, max)
    : [];

/** The model's JSON as criteria, or null when it is not usable. */
export function criteriaFromModel(raw: unknown): ReferralCriteria | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const designations = arr(r.designations, 6);
  const companies = arr(r.companies, MAX_TERMS);
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : null;
  if (!designations.length && !companies.length && !name) return null;
  return {
    designations,
    companies,
    name,
    loose: null,
    needsContact: r.needsContact === true,
    industry: typeof r.industry === "string" && r.industry.trim() ? r.industry.trim() : null,
    summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim().slice(0, 140) : "",
  };
}

// ─── Reading without a model ─────────────────────────────────────────────────

const TITLE_WORDS =
  "manager|managers|director|directors|head|executive|executives|officer|officers|chief|ceo|cfo|coo|cto|gm|agm|vp|president|chairman|supervisor|supervisors|lead|leads|engineer|accountant|controller|consultant|partner|owner";
const TITLE_RE = new RegExp(`\\b((?:[a-z]+\\s+){0,2}(?:${TITLE_WORDS})(?:\\s+(?:of|-)\\s+[a-z]+)?)\\b`, "gi");
const FILLER = new Set(["find", "show", "me", "all", "the", "referees", "referee", "references", "reference", "people", "persons", "who", "are", "is", "working", "work", "works", "from", "at", "in", "of", "for", "with", "companies", "company", "contact", "details", "phone", "numbers", "number", "email", "emails", "and", "their", "a", "an", "to", "list", "give", "get", "any", "that", "have", "has"]);

/** Short forms a CV uses, and what they stand for. Only for reading without a model. */
const SHORT: Record<string, string[]> = {
  gm: ["General Manager"],
  agm: ["Assistant General Manager"],
  hr: ["Human Resources"],
  ceo: ["Chief Executive Officer"],
  cfo: ["Chief Financial Officer"],
  coo: ["Chief Operating Officer"],
  cto: ["Chief Technology Officer"],
};

const singular = (w: string) => (/[^s]s$/i.test(w) && w.length > 4 ? w.slice(0, -1) : w);
const cap = (w: string) => (w === w.toUpperCase() || /^(of|-)$/i.test(w) ? w : w[0].toUpperCase() + w.slice(1));

/**
 * The words alone, when no model answered. Cruder: it finds titles and a
 * capitalised company after "at/from", and knows no synonyms beyond the short
 * forms above. Enough that the search still works while Claude and DeepSeek
 * are both away.
 */
export function ruleRead(text: string): ReferralCriteria {
  const said = text.replace(/\s+/g, " ").trim();
  const needsContact = /\b(contact|phone|number|numbers|email|emails|mobile|details)\b/i.test(said);

  const designations: string[] = [];
  for (const m of said.matchAll(TITLE_RE)) {
    const words = m[1].trim().split(/\s+/).filter((w) => !FILLER.has(w.toLowerCase()) || /^(of|-)$/i.test(w));
    if (!words.length) continue;
    const phrase = words.map((w, i) => cap(i === words.length - 1 ? singular(w) : w)).join(" ");
    designations.push(phrase);
    const first = words[0].toLowerCase();
    const last = words[words.length - 1].toLowerCase();
    if (SHORT[first]) designations.push(`${SHORT[first].join(" ")} ${words.slice(1).map(singular).join(" ")}`.trim());
    if (words.length === 1 && SHORT[last]) designations.push(...SHORT[last]);
  }

  const companies: string[] = [];
  const at = said.match(/\b(?:at|from|in|with|of)\s+([A-Z][\w&.'-]*(?:\s+[A-Z&][\w&.'-]*)*)/);
  if (at) companies.push(at[1].trim());

  const rest = said
    .split(/\s+/)
    .map((w) => w.replace(/[^\w&.'-]/g, ""))
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  // One word and nothing recognised in it: it could be a company ("Dialog"), a
  // title ("GM") or a name, so all three are searched.
  const loose = !designations.length && !companies.length && rest.length === 1 ? rest[0] : null;
  // A few words and nothing recognised: treat what is left as a company.
  if (!designations.length && !companies.length && !loose && rest.length) companies.push(rest.join(" "));

  const d = [...new Set(designations)].slice(0, 6);
  const c = [...new Set(companies)];
  return {
    designations: d,
    companies: c,
    name: null,
    loose,
    needsContact,
    industry: null,
    summary: summaryOf({ designations: d, companies: c, loose, needsContact }),
  };
}

export function summaryOf(c: Pick<ReferralCriteria, "designations" | "companies" | "loose" | "needsContact">): string {
  const parts = [
    c.designations[0] ? `${c.designations[0]}s` : null,
    c.companies[0] ? (c.companies.length > 1 ? `${c.companies[0]} +${c.companies.length - 1}` : c.companies[0]) : null,
    c.loose,
    c.needsContact ? "with contact details" : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Everyone";
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** Words that carry no identity in a title or a company name. */
const NOISE = new Set(["of", "the", "and", "for", "a", "an", "at", "in", "pvt", "ltd", "plc", "limited", "private", "co", "inc", "llc", "pty", "lanka", "sri"]);

/** Lower-case words, in order, noise removed. "Head of H.R." → ["head", "hr"]. */
export function tokens(s: string | null | undefined, keepNoise = false): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/\bh\.\s?r\.?/g, "hr")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && (keepNoise || !NOISE.has(t)));
}

const stem = (t: string) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t);

/**
 * Every word of the term appears in the field, plural or singular ("Keell" and
 * "Keells" are the same word; "Dialog" is not "Dialogue"). "Sri Lanka" and "Pvt
 * Ltd" are noise on both sides, so "Dialog" matches "Dialog Axiata PLC".
 */
export function termMatches(field: string | null | undefined, term: string): boolean {
  const want = tokens(term);
  if (!want.length) return false;
  const have = tokens(field).map(stem);
  return want.every((w) => {
    const s = stem(w);
    return have.includes(s);
  });
}

/** The index of the first term the field matches; -1 for none. */
export function firstMatch(field: string | null | undefined, terms: string[]): number {
  return terms.findIndex((t) => termMatches(field, t));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export type RefRow = {
  id: string;
  candidateId: string;
  name: string;
  designation: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  /** When it was read off the CV, ms. */
  at: number;
};

export type Scored = RefRow & {
  score: number;
  /** Why it matched, for the pill on the card. */
  why: string[];
};

/**
 * A tier per question, not a points sum:
 *   name asked for and matched                 300
 *   title: the typed one 200, an equivalent 100
 *   company: the typed one 200, a variant 100
 *   contact: a phone and an email 20, one of them 10
 * Then newest first.
 */
export function scoreReferee(r: RefRow, c: ReferralCriteria): Scored {
  let score = 0;
  const why: string[] = [];

  if (c.name && termMatches(r.name, c.name)) {
    score += 300;
    why.push(`Name: ${r.name}`);
  }
  if (c.designations.length) {
    const i = firstMatch(r.designation, c.designations);
    if (i >= 0) {
      score += i === 0 ? 200 : 100;
      why.push(i === 0 ? `Title: ${r.designation}` : `Similar title: ${r.designation}`);
    }
  }
  if (c.companies.length) {
    const i = firstMatch(r.company, c.companies);
    if (i >= 0) {
      score += i === 0 ? 200 : 100;
      why.push(i === 0 ? `Company: ${r.company}` : c.industry ? `${c.industry} company: ${r.company}` : `Related company: ${r.company}`);
    }
  }
  if (c.loose) {
    if (termMatches(r.designation, c.loose)) { score += 150; why.push(`Title: ${r.designation}`); }
    if (termMatches(r.company, c.loose)) { score += 150; why.push(`Company: ${r.company}`); }
    if (termMatches(r.name, c.loose)) { score += 150; why.push(`Name: ${r.name}`); }
  }
  score += (r.phone ? 10 : 0) + (r.email ? 10 : 0);
  return { ...r, score, why };
}

/**
 * Does the row answer the search? Everything asked must hold: a title AND a
 * company when both were typed ("HR Manager at Dialog" is not 50 HR managers
 * plus 50 Dialog people). Rows without the contact asked for are out.
 */
export function answers(r: RefRow, c: ReferralCriteria): boolean {
  if (c.needsContact && !r.phone && !r.email) return false;
  if (c.name && !termMatches(r.name, c.name)) return false;
  if (c.designations.length && firstMatch(r.designation, c.designations) < 0) return false;
  if (c.companies.length && firstMatch(r.company, c.companies) < 0) return false;
  if (c.loose && !(termMatches(r.designation, c.loose) || termMatches(r.company, c.loose) || termMatches(r.name, c.loose))) return false;
  return true;
}

// ─── One person, many rows ───────────────────────────────────────────────────

export type Person = Scored & {
  /** Every row that is this person; the first is the one shown. */
  rowIds: string[];
  candidateIds: string[];
};

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** What makes two rows the same person: the same number, else the same email, else the same name at the same company. */
export function personKey(r: RefRow): string {
  const p = digits(r.phone);
  if (p.length >= 7) return `p:${p.slice(-9)}`;
  const e = (r.email ?? "").trim().toLowerCase();
  if (e) return `e:${e}`;
  return `n:${tokens(r.name, true).join(" ")}|${tokens(r.company).join(" ")}`;
}

/**
 * The same HR manager is named by every candidate who worked under them. One
 * row per person, the fullest one shown, with the others' phone or email filled
 * in, and every candidate who named them kept.
 */
export function groupPeople(rows: Scored[]): Person[] {
  const by = new Map<string, Person>();
  const fullness = (r: RefRow) => [r.designation, r.company, r.phone, r.email].filter(Boolean).length;
  for (const r of rows) {
    const k = personKey(r);
    const held = by.get(k);
    if (!held) {
      by.set(k, { ...r, rowIds: [r.id], candidateIds: [r.candidateId] });
      continue;
    }
    held.rowIds.push(r.id);
    if (!held.candidateIds.includes(r.candidateId)) held.candidateIds.push(r.candidateId);
    const best = fullness(r) > fullness(held) || (fullness(r) === fullness(held) && r.score > held.score) ? r : held;
    const next: Person = {
      ...best,
      phone: best.phone ?? held.phone ?? r.phone,
      email: best.email ?? held.email ?? r.email,
      designation: best.designation ?? held.designation ?? r.designation,
      company: best.company ?? held.company ?? r.company,
      score: Math.max(held.score, r.score),
      // The pills of the row shown, not both rows' (that said "Title" twice).
      why: best.why,
      rowIds: held.rowIds,
      candidateIds: held.candidateIds,
    };
    by.set(k, next);
  }
  // More candidates naming someone is a sign they are known, so it breaks ties.
  return [...by.values()].sort((a, b) => b.score - a.score || b.candidateIds.length - a.candidateIds.length || b.at - a.at);
}

// ─── Reading a sentence: Claude, then DeepSeek, then the words ───────────────

export type Asker = (system: string, prompt: string) => Promise<string | null>;
export type ReadVia = "claude" | "deepseek" | "words";

/**
 * Claude first, as for every search sentence (6 Oct); DeepSeek when Claude gives
 * nothing usable; the plain-words reading when neither does. An asker returns
 * null for "no answer" and may throw — either way the next one is tried. A
 * sentence that reads as nothing at all (a model answering with empty lists) is
 * also "no answer".
 */
export async function readCriteria(
  text: string,
  askers: { claude: Asker; deepseek: Asker },
): Promise<{ criteria: ReferralCriteria; via: ReadVia }> {
  const said = text.replace(/\s+/g, " ").trim();
  for (const via of ["claude", "deepseek"] as const) {
    try {
      const answer = await askers[via](REFERRAL_SYSTEM, referralPrompt(said));
      const parsed = answer ? criteriaFromModel(jsonIn(answer)) : null;
      if (parsed) {
        // A bare word stays a bare word: the model may call it a company when it is a surname.
        const ruled = ruleRead(said);
        // Only when the whole search is that one word; "contact details of referees from retail" has one word left over, and the model's list should stand.
        if (ruled.loose && !/\s/.test(said)) return { criteria: { ...ruled, needsContact: ruled.needsContact || parsed.needsContact }, via };
        return { criteria: { ...parsed, needsContact: parsed.needsContact || ruled.needsContact, summary: parsed.summary || summaryOf(parsed) }, via };
      }
    } catch (e: any) {
      console.warn(`[referral-search] ${via} unusable: ${e?.message || e}`);
    }
  }
  return { criteria: ruleRead(said), via: "words" };
}
