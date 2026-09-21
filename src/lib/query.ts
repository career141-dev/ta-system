import { EMPTY_CRITERIA, type Candidate, type SearchCriteria } from "@/data/types";
import { parseSalary } from "./backup";

/**
 * Reading a recruiter's sentence — spec §6D.
 *
 * The rule is the one brief extraction already follows (§5): understand what is
 * plainly there, leave everything else blank, and say out loud what was ignored.
 * A search that quietly invents a filter is worse than one that finds too much,
 * because the TA cannot see the candidates it silently removed.
 *
 * In stage one this is deterministic — vocabulary matching and a set of tested
 * patterns. At phase 8 a model can replace `parseQuery` alone: everything
 * downstream consumes `SearchCriteria`, not prose.
 */

export interface Vocabulary {
  titles: string[];
  skills: string[];
  industries: string[];
  cities: string[];
  employers: string[];
  qualifications: string[];
  languages: string[];
  nationalities: string[];
}

export interface Chip {
  field: keyof SearchCriteria;
  /** What the chip says on screen. */
  label: string;
  /** The value to strip when the chip is removed; absent means clear the field. */
  value?: string;
}

export interface ParseResult {
  criteria: SearchCriteria;
  understood: Chip[];
  /** Words that carried no meaning the parser could act on. Shown, never hidden. */
  ignored: string[];
}

const STOP = new Set([
  "i", "im", "a", "an", "the", "and", "or", "for", "with", "who", "has", "have", "in", "at",
  "of", "to", "is", "are", "be", "looking", "need", "want", "find", "me", "someone", "somebody",
  "candidate", "candidates", "person", "people", "profile", "profiles", "cv", "cvs", "experience",
  "experienced", "proven", "strong", "good", "solid", "ideally", "preferably", "please", "please.",
  "years", "year", "yrs", "yr", "plus", "least", "minimum", "maximum", "over", "under", "than",
  "more", "less", "from", "not", "no", "excluding", "except", "only", "must", "should", "can",
  "their", "his", "her", "they", "we", "our", "us", "it", "that", "this", "these", "those",
  "role", "roles", "position", "positions", "job", "jobs", "work", "working", "background",
  "expecting", "expects", "expectation", "salary", "package", "notice", "joiner", "days", "available",
]);

/** Longest-first so "Head of Finance" wins over "Finance". */
function matchVocab(text: string, vocab: string[]): string[] {
  const out: string[] = [];
  const ordered = [...vocab].sort((a, b) => b.length - a.length);
  let remaining = text;
  for (const term of ordered) {
    const t = term.toLowerCase();
    if (!t) continue;
    const re = new RegExp(`(?<![a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i");
    if (re.test(remaining)) {
      out.push(term);
      remaining = remaining.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  return out;
}

function num(m: RegExpMatchArray | null, i = 1): number | null {
  if (!m) return null;
  const n = Number(m[i]);
  return Number.isFinite(n) ? n : null;
}

/**
 * A vocabulary word as a pattern that matches only itself. Titles and
 * employers come from real CVs — "C++ Developer", "ABC (Pvt" — and were
 * turned into patterns unescaped, so one of them in a query threw and broke the
 * results page (21 September).
 */
function literal(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseQuery(raw: string, vocab: Vocabulary): ParseResult {
  const c: SearchCriteria = structuredClone(EMPTY_CRITERIA);
  const text = ` ${raw.toLowerCase().replace(/\s+/g, " ").trim()} `;
  let rest = text;
  const eat = (re: RegExp) => {
    rest = rest.replace(re, " ");
  };

  // 1. Exclusions first. "not from Everest" must never be read as "from Everest"
  //    — the same negation-first rule the urgency parser learned the hard way.
  const exRe = /\b(?:not from|excluding|except|other than|but not|no one from|nobody from)\s+([a-z0-9 &'.-]{3,40}?)(?=,|\.|$| and | with | who | in | at )/gi;
  for (const m of text.matchAll(exRe)) {
    const found = matchVocab(m[1], vocab.employers);
    c.excludeEmployers.push(...found);
    eat(new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
  }

  // 2. Numbers. Ranges before bounds, bounds before bare figures.
  const expRange = rest.match(/\b(\d{1,2})\s*(?:-|–|to|and)\s*(\d{1,2})\s*(?:\+)?\s*(?:years|yrs?)\b/);
  if (expRange) {
    c.minExperience = num(expRange, 1);
    c.maxExperience = num(expRange, 2);
    eat(new RegExp(expRange[0], "i"));
  } else {
    const expMin = rest.match(/\b(?:at least|minimum|min|over|more than|above)\s*(\d{1,2})\s*(?:\+)?\s*(?:years|yrs?)\b/) ??
      rest.match(/\b(\d{1,2})\s*\+\s*(?:years|yrs?)\b/) ??
      rest.match(/\b(\d{1,2})\s*(?:years|yrs?)\b/);
    if (expMin) {
      c.minExperience = num(expMin);
      eat(new RegExp(expMin[0].replace(/[+]/g, "\\+"), "i"));
    }
  }

  if (/\b(immediate|immediately available|can join (?:at once|immediately)|available now)\b/.test(rest)) {
    c.maxNoticeDays = 14;
    eat(/\b(immediate|immediately available|can join (?:at once|immediately)|available now)\b/gi);
  }
  const notice = rest.match(/\b(?:notice|join|joining|available)[a-z ]{0,18}?(\d{1,3})\s*(days?|weeks?|months?)\b/) ??
    rest.match(/\b(\d{1,3})\s*(days?|weeks?|months?)\s*(?:notice)\b/);
  if (notice) {
    const n = Number(notice[1]);
    const unit = notice[2];
    c.maxNoticeDays = unit.startsWith("week") ? n * 7 : unit.startsWith("month") ? n * 30 : n;
    eat(new RegExp(notice[0], "i"));
  } else if (/\bwithin a month\b|\bin a month\b|\bone month notice\b/.test(rest)) {
    c.maxNoticeDays = 30;
    eat(/\bwithin a month\b|\bin a month\b|\bone month notice\b/gi);
  }

  const ageRange = rest.match(/\b(?:aged?|age)\s*(\d{2})\s*(?:-|–|to|and)\s*(\d{2})\b/);
  if (ageRange) {
    c.minAge = num(ageRange, 1);
    c.maxAge = num(ageRange, 2);
    eat(new RegExp(ageRange[0], "i"));
  } else {
    const ageMax = rest.match(/\b(?:under|below|younger than)\s*(\d{2})\b(?!\s*(?:k|m|years?|yrs?|days?|weeks?|months?))/);
    if (ageMax) {
      c.maxAge = num(ageMax);
      eat(new RegExp(ageMax[0], "i"));
    }
    const ageMin = rest.match(/\b(?:over|above|older than)\s*(\d{2})\b(?!\s*(?:k|m|years?|yrs?|days?|weeks?|months?))/);
    if (ageMin) {
      c.minAge = num(ageMin);
      eat(new RegExp(ageMin[0], "i"));
    }
  }

  const sal = rest.match(/\b(?:under|below|less than|up to|max(?:imum)?|within)\s*(?:lkr\s*)?(?:rs\.?\s*)?(\d[\d,.]*)\s*(k|m|million)?\b/);
  if (sal) {
    const parsed = parseSalary(`${sal[1]}${sal[2] ?? "K"}`);
    if (parsed) {
      // Expectations on a CV read "620K gross" — normalise everything to rupees.
      c.maxExpectedSalary = parsed.amount < 10_000 ? parsed.amount * 1_000 : parsed.amount;
      eat(new RegExp(sal[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
  }

  const eng = rest.match(/\benglish\s*(?:of|at|above|over)?\s*(\d{1,2})\b/);
  if (eng) {
    c.minEnglish = num(eng);
    eat(new RegExp(eng[0], "i"));
  } else if (/\b(?:fluent|excellent|strong|good) english\b/.test(rest)) {
    c.minEnglish = 8;
    eat(/\b(?:fluent|excellent|strong|good) english\b/gi);
  }

  // 3. Enums.
  if (/\bfemale\b|\bwomen\b/.test(rest)) {
    c.gender = "Female";
    eat(/\bfemale\b|\bwomen\b/gi);
  } else if (/\bmale\b|\bmen\b/.test(rest)) {
    c.gender = "Male";
    eat(/\bmale\b|\bmen\b/gi);
  }

  if (/\b(?:not (?:already )?(?:in|on) a pipeline|free to approach|nobody is working|unworked|untouched)\b/.test(rest)) {
    c.availability = "free";
    eat(/\b(?:not (?:already )?(?:in|on) a pipeline|free to approach|nobody is working|unworked|untouched)\b/gi);
  } else if (/\b(?:placed (?:by us|before)|our alumni|previously placed)\b/.test(rest)) {
    c.availability = "placed_before";
    eat(/\b(?:placed (?:by us|before)|our alumni|previously placed)\b/gi);
  }

  // 4. Vocabulary. Titles before skills so "Sales Manager" is not eaten by "Sales".
  c.titles = matchVocab(rest, vocab.titles);
  for (const t of c.titles) eat(new RegExp(literal(t), "gi"));
  c.skills = matchVocab(rest, vocab.skills);
  for (const t of c.skills) eat(new RegExp(literal(t), "gi"));
  c.industries = matchVocab(rest, vocab.industries);
  for (const t of c.industries) eat(new RegExp(literal(t), "gi"));
  c.locations = matchVocab(rest, vocab.cities);
  for (const t of c.locations) eat(new RegExp(literal(t), "gi"));
  c.employers = matchVocab(rest, vocab.employers).filter((e) => !c.excludeEmployers.includes(e));
  for (const t of c.employers) eat(new RegExp(literal(t), "gi"));
  c.qualifications = matchVocab(rest, vocab.qualifications);
  for (const t of c.qualifications) eat(new RegExp(literal(t), "gi"));
  c.languages = matchVocab(rest, vocab.languages);
  for (const t of c.languages) eat(new RegExp(literal(t), "gi"));
  c.nationalities = matchVocab(rest, vocab.nationalities);
  for (const t of c.nationalities) eat(new RegExp(literal(t), "gi"));

  const ignored = [
    ...new Set(
      rest
        .split(/[^a-z0-9+]+/i)
        .map((w) => w.trim())
        .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)),
    ),
  ];

  return { criteria: c, understood: describe(c), ignored };
}

// ─── Describing criteria back to the person who typed them ───────────────────

export function describe(c: SearchCriteria): Chip[] {
  const chips: Chip[] = [];
  const many = (field: keyof SearchCriteria, values: string[], prefix = "") =>
    values.forEach((v) => chips.push({ field, label: `${prefix}${v}`, value: v }));

  many("titles", c.titles);
  many("skills", c.skills);
  many("industries", c.industries);
  many("employers", c.employers, "at ");
  many("excludeEmployers", c.excludeEmployers, "not ");
  many("locations", c.locations, "in ");
  many("qualifications", c.qualifications);
  many("languages", c.languages);
  many("nationalities", c.nationalities);

  if (c.minExperience !== null && c.maxExperience !== null)
    chips.push({ field: "minExperience", label: `${c.minExperience}–${c.maxExperience} years` });
  else if (c.minExperience !== null) chips.push({ field: "minExperience", label: `${c.minExperience}+ years` });
  else if (c.maxExperience !== null) chips.push({ field: "maxExperience", label: `up to ${c.maxExperience} years` });

  if (c.minAge !== null && c.maxAge !== null) chips.push({ field: "minAge", label: `aged ${c.minAge}–${c.maxAge}` });
  else if (c.maxAge !== null) chips.push({ field: "maxAge", label: `under ${c.maxAge}` });
  else if (c.minAge !== null) chips.push({ field: "minAge", label: `over ${c.minAge}` });

  if (c.gender) chips.push({ field: "gender", label: c.gender });
  if (c.maxNoticeDays !== null) chips.push({ field: "maxNoticeDays", label: `notice ≤ ${c.maxNoticeDays} days` });
  if (c.minEnglish !== null) chips.push({ field: "minEnglish", label: `English ${c.minEnglish}+` });
  if (c.maxExpectedSalary !== null)
    chips.push({ field: "maxExpectedSalary", label: `expects ≤ ${Math.round(c.maxExpectedSalary / 1000)}K` });
  if (c.availability !== "any")
    chips.push({
      field: "availability",
      label: { free: "free to approach", in_pipeline: "already in a pipeline", placed_before: "placed by us before" }[
        c.availability
      ],
    });

  return chips;
}

/** The same criteria as a boolean string — they still run these on LinkedIn. */
export function toBooleanString(c: SearchCriteria): string {
  const group = (xs: string[]) =>
    xs.length === 0 ? null : xs.length === 1 ? `"${xs[0]}"` : `(${xs.map((x) => `"${x}"`).join(" OR ")})`;
  const parts = [group(c.titles), group(c.skills), group(c.industries), group(c.locations), group(c.qualifications)]
    .filter(Boolean)
    .join(" AND ");
  const nots = c.excludeEmployers.map((e) => `NOT "${e}"`).join(" ");
  return [parts, nots].filter(Boolean).join(" ").trim();
}

// ─── Boolean mode ────────────────────────────────────────────────────────────

export type Node =
  | { t: "term"; v: string }
  | { t: "and"; xs: Node[] }
  | { t: "or"; xs: Node[] }
  | { t: "not"; x: Node };

/** A small recursive-descent parser: quotes, parentheses, AND / OR / NOT. */
export function parseBoolean(input: string): { node: Node | null; error: string | null } {
  const tokens = input.match(/"[^"]*"|\(|\)|\bAND\b|\bOR\b|\bNOT\b|[^\s()]+/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (t: string | undefined, op: string) => !!t && t.toUpperCase() === op;

  function parseOr(): Node | null {
    const xs: Node[] = [];
    const first = parseAnd();
    if (!first) return null;
    xs.push(first);
    while (isOp(peek(), "OR")) {
      i++;
      const next = parseAnd();
      if (!next) return null;
      xs.push(next);
    }
    return xs.length === 1 ? xs[0] : { t: "or", xs };
  }

  function parseAnd(): Node | null {
    const xs: Node[] = [];
    for (;;) {
      const u = parseUnary();
      if (!u) break;
      xs.push(u);
      if (isOp(peek(), "AND")) {
        i++;
        continue;
      }
      // Adjacent terms with no operator read as AND, the way recruiters type them.
      if (peek() && !isOp(peek(), "OR") && peek() !== ")") continue;
      break;
    }
    if (xs.length === 0) return null;
    return xs.length === 1 ? xs[0] : { t: "and", xs };
  }

  function parseUnary(): Node | null {
    const t = peek();
    if (!t) return null;
    if (isOp(t, "NOT")) {
      i++;
      const x = parseUnary();
      return x ? { t: "not", x } : null;
    }
    if (t === "(") {
      i++;
      const inner = parseOr();
      if (peek() === ")") i++;
      return inner;
    }
    if (t === ")" || isOp(t, "AND") || isOp(t, "OR")) return null;
    i++;
    return { t: "term", v: t.replace(/^"|"$/g, "").toLowerCase() };
  }

  const node = parseOr();
  if (!node) return { node: null, error: "Nothing to search for — try a word, or a phrase in quotes." };
  if (i < tokens.length && tokens[i] !== ")") return { node, error: `Could not read from "${tokens[i]}" onward.` };
  return { node, error: null };
}

/** A boolean tree read back in words, so the panel can show its reading too. */
export function describeBoolean(node: Node): { must: string[]; any: string[][]; not: string[] } {
  const must: string[] = [];
  const any: string[][] = [];
  const not: string[] = [];
  const walk = (n: Node, negated = false) => {
    switch (n.t) {
      case "term":
        (negated ? not : must).push(n.v);
        break;
      case "and":
        n.xs.forEach((x) => walk(x, negated));
        break;
      case "or": {
        const terms = n.xs.filter((x): x is { t: "term"; v: string } => x.t === "term").map((x) => x.v);
        // NOT ("a" OR "b") excludes both, so a negated group flattens into `not`.
        if (terms.length) {
          if (negated) not.push(...terms);
          else any.push(terms);
        }
        n.xs.filter((x) => x.t !== "term").forEach((x) => walk(x, negated));
        break;
      }
      case "not":
        walk(n.x, !negated);
        break;
    }
  };
  walk(node);
  return { must, any, not };
}

export function evalBoolean(node: Node, haystack: string): boolean {
  switch (node.t) {
    case "term":
      return haystack.includes(node.v);
    case "and":
      return node.xs.every((x) => evalBoolean(x, haystack));
    case "or":
      return node.xs.some((x) => evalBoolean(x, haystack));
    case "not":
      return !evalBoolean(node.x, haystack);
  }
}

export function haystackFor(c: Candidate): string {
  return [
    c.fullName, c.currentTitle, c.currentEmployer, c.location, c.nationality,
    c.educationDegree, c.educationInstitution, c.qualifications,
    ...c.skills, ...c.industries, ...c.languages,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// ─── Criteria in the URL ─────────────────────────────────────────────────────
//
// The whole search lives in the query string: shareable, back-button-safe, and
// server-rendered like every other list in the app. Removing a chip is a link,
// not a click handler.

const LIST_FIELDS = [
  "titles", "skills", "industries", "employers", "excludeEmployers",
  "locations", "nationalities", "languages", "qualifications",
] as const;

const NUM_FIELDS = [
  "minExperience", "maxExperience", "minAge", "maxAge",
  "maxNoticeDays", "minEnglish", "maxExpectedSalary",
] as const;

export type SearchParams = Record<string, string | string[] | undefined>;

export function criteriaFromParams(p: SearchParams): SearchCriteria {
  const c: SearchCriteria = structuredClone(EMPTY_CRITERIA);
  const all = (k: string): string[] => {
    const v = p[k];
    if (v === undefined) return [];
    return (Array.isArray(v) ? v : [v]).flatMap((x) => x.split("~")).filter(Boolean);
  };
  for (const f of LIST_FIELDS) c[f] = all(f);
  for (const f of NUM_FIELDS) {
    const v = all(f)[0];
    c[f] = v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  }
  const g = all("gender")[0];
  c.gender = g ?? null;
  const av = all("availability")[0];
  c.availability = (["free", "in_pipeline", "placed_before"] as const).includes(av as never)
    ? (av as SearchCriteria["availability"])
    : "any";
  return c;
}

export function criteriaToParams(c: SearchCriteria): URLSearchParams {
  const q = new URLSearchParams();
  for (const f of LIST_FIELDS) if (c[f].length) q.set(f, c[f].join("~"));
  for (const f of NUM_FIELDS) if (c[f] !== null) q.set(f, String(c[f]));
  if (c.gender) q.set("gender", c.gender);
  if (c.availability !== "any") q.set("availability", c.availability);
  return q;
}

/** The URL with one chip taken out — what the chip's ✕ links to. */
export function withoutChip(c: SearchCriteria, chip: Chip, extra: Record<string, string> = {}): string {
  const next = structuredClone(c);
  const f = chip.field;
  if (chip.value !== undefined && Array.isArray(next[f])) {
    (next[f] as string[]) = (next[f] as string[]).filter((v) => v !== chip.value);
  } else if (f === "minExperience" || f === "maxExperience") {
    next.minExperience = null;
    next.maxExperience = null;
  } else if (f === "minAge" || f === "maxAge") {
    next.minAge = null;
    next.maxAge = null;
  } else if (f === "availability") {
    next.availability = "any";
  } else if (f === "gender") {
    next.gender = null;
  } else {
    (next[f] as number | null) = null;
  }
  const q = criteriaToParams(next);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  // Marks the criteria as edited. Without it, taking off the LAST chip left no
  // criteria in the URL, so the page re-read the sentence and put the chip
  // straight back (audit finding 38).
  q.set("edited", "1");
  return `?${q.toString()}`;
}

/** The URL with one value added — what a suggestion links to. */
export function withValue(
  c: SearchCriteria,
  field: (typeof LIST_FIELDS)[number],
  value: string,
  extra: Record<string, string> = {},
): string {
  const next = structuredClone(c);
  if (!next[field].includes(value)) next[field] = [...next[field], value];
  const q = criteriaToParams(next);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  q.set("edited", "1");
  return `?${q.toString()}`;
}
