/**
 * Names, for the Referral Search (29 Oct): is this a pasted list of names, and
 * is this typed name the same person as that one on file?
 *
 * A TA drops a list in casually — one per line, comma-separated, numbered, with
 * "Mr" in front — and wants to know who is already in the database. And beside
 * a referee, the TA wants to know "we hold a CV for someone with this name, maybe
 * them". Both need the same forgiving read of a name, and neither may claim more
 * than it knows: a match is a prompt to open the CV and look, never a verdict.
 */

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "eng", "rev", "sir", "madam", "hon"]);

// Words that make a chunk a question or a company, not a person: "HR Managers at
// Dialog" must never be taken for a list of names.
const NOT_NAME = new Set([
  "manager", "managers", "director", "directors", "officer", "officers", "executive", "executives", "engineer", "engineers",
  "head", "heads", "senior", "junior", "assistant", "hr", "gm", "ceo", "cfo", "coo", "cto", "vp", "at", "in", "from", "of", "the",
  "and", "for", "with", "to", "references", "reference", "referees", "referee", "referral", "contact", "contacts", "details",
  "companies", "company", "retail", "fmcg", "bank", "group", "holdings", "limited", "ltd", "pvt", "plc", "inc", "lanka",
  "department", "team", "who", "whom", "find", "show", "get", "list", "people", "person", "all", "any",
]);

const stripMarks = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

/** The words of a name, lower-case, with accents, dots and apostrophes gone. */
export function nameWords(name: string): string[] {
  const words = stripMarks(name)
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\s-]/gu, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && HONORIFICS.has(words[0])) words.shift();
  return words;
}

const key = (name: string) => nameWords(name).sort().join(" ");

/** A pasted block as its separate entries: lines, commas, semicolons, tabs, bars. */
export function splitNameList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n\r;|\t,]+/)) {
    // "1.", "2)", "-", "•": a list's own markers are not part of the name.
    const chunk = raw.replace(/^\s*(?:[-*•·–—]+|\d+\s*[.):-])\s*/, "").replace(/\s+/g, " ").trim();
    if (!chunk) continue;
    const k = key(chunk);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(chunk);
  }
  return out.slice(0, 100);
}

/** Two to five words of letters (or initials), none of them a role or company word. */
export function looksLikeName(chunk: string): boolean {
  const words = chunk.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => /^\p{L}[\p{L}'’.-]*$/u.test(w) && !NOT_NAME.has(stripMarks(w).toLowerCase().replace(/[.'’]/g, "")));
}

/** The names in a pasted list, or null when anything in it is not a name. */
export function nameList(text: string): string[] | null {
  const chunks = splitNameList(text);
  return chunks.length > 0 && chunks.every(looksLikeName) ? chunks : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const held = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = held;
    }
  }
  return row[b.length];
}

/** Every word of `small` is a word of `big`, or an initial of one: each used once. */
function fits(small: string[], big: string[]): boolean {
  const free = [...big];
  for (const w of small) {
    const at = free.findIndex((x) => x === w) >= 0 ? free.findIndex((x) => x === w) : w.length === 1 ? free.findIndex((x) => x.startsWith(w)) : -1;
    if (at < 0) return false;
    free.splice(at, 1);
  }
  return true;
}

export type NameMatch = "same" | "likely" | "maybe";

/**
 * How the typed name sits against one on file, or null when it is someone else.
 *  same   — the same words, in any order.
 *  likely — one holds all of the other: a middle name, or an initial for a first name.
 *  maybe  — a word is shared and the others are one letter apart: "Pereira", "Perera".
 * Sharing only a first name, or only a surname, is not a match.
 */
export function nameMatch(typed: string, held: string): NameMatch | null {
  const t = nameWords(typed);
  const h = nameWords(held);
  if (t.length < 2 || h.length < 2) return null;
  if (t.slice().sort().join(" ") === h.slice().sort().join(" ")) return "same";
  if (fits(t, h) || fits(h, t)) return "likely";

  const left = [...h];
  const rest: string[] = [];
  let shared = 0;
  for (const w of t) {
    const at = left.indexOf(w);
    if (at >= 0 && w.length >= 3) {
      left.splice(at, 1);
      shared++;
    } else rest.push(w);
  }
  if (shared === 0 || rest.length === 0 || rest.length !== left.length) return null;
  const close = (a: string, b: string) => a.length >= 4 && b.length >= 4 && distance(a, b) <= 1;
  return rest.every((w) => left.some((x) => close(w, x))) ? "maybe" : null;
}
