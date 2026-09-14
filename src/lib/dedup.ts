/**
 * Candidate identity: deciding whether a CV that just arrived belongs to
 * somebody already on the database.
 *
 * Ported from the live system's "4-factor deduplication" (fileHash, email,
 * phone, linkedinUrl — first index hit wins, then merge). Four things are
 * changed on the way across, each because the original loses real duplicates
 * or merges real strangers:
 *
 *  1. The keys are NORMALISED before they are compared. The live dedup looks
 *     up `by_phone` on the raw string it was given, so `+94 77 123 4567`,
 *     `0771234567` and `94771234567` are three different people. The desk
 *     writes all three. (The live schema does carry a `phoneClean` field and a
 *     `by_phoneClean` index — search uses it, dedup does not.)
 *
 *  2. A strong key that matches while the NAME disagrees is not treated as
 *     proof. One phone number on two CVs is routine here: a shared household
 *     line, a father's number on a school-leaver's CV, an agent sending on
 *     behalf of several people. The live code merges those two records into
 *     one person and the second CV overwrites the first.
 *
 *  3. Names are compared in a form that survives how Sri Lankan names are
 *     actually written — initials on one CV, the expansion on the next
 *     ("W.A.D.S. Perera" / "Wijesinghe Arachchige Don Sunil Perera").
 *
 *  4. The verdict is three-valued. `same` is acted on, `review` is shown to a
 *     human, `new` is admitted. Nothing merges two records on a guess.
 *
 * Pure module: no store, no I/O, no model. Everything here is decidable from
 * two records, which is what makes it testable and what keeps it honest.
 */

export interface Identity {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  currentEmployer?: string | null;
  location?: string | null;
  /** SHA-256 of the CV file, when the record came in with one. */
  fileHash?: string | null;
}

// ─────────────────────────────────────────────────────────── normalisation ──

/**
 * Gmail ignores dots and everything after a `+` in the local part; no other
 * common provider does. Folding those for every domain would merge
 * `accounts@` and `accounts+hr@` at a company that treats them as two
 * mailboxes, so the fold is applied only where it is actually true.
 */
const DOT_FOLDING_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function emailKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  const m = t.match(/^([^\s@]+)@([^\s@]+\.[a-z]{2,})$/);
  if (!m) return null;
  let [, local, domain] = m;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (DOT_FOLDING_DOMAINS.has(domain)) {
    local = local.split("+")[0].replace(/\./g, "");
  }
  return local && domain ? `${local}@${domain}` : null;
}

/**
 * Sri Lankan mobiles are written four ways on the same desk: `0771234567`,
 * `77 123 4567`, `+94 77 123 4567`, `94771234567`. All four are one number.
 * Everything is reduced to digits and, where the shape is recognisably local,
 * given the country code so the four collapse into one key.
 *
 * Foreign numbers keep whatever digits they came with — guessing a country
 * code for a number we cannot place would invent an identity.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D+/g, "");
  if (!d) return null;
  // 00-prefixed international dialling.
  if (d.startsWith("00")) d = d.slice(2);
  // Local trunk form: 0 + 9 digits.
  if (d.length === 10 && d.startsWith("0")) d = "94" + d.slice(1);
  // Bare subscriber number, no trunk zero: 9 digits starting 7 (mobile) or a
  // known area code.
  else if (d.length === 9 && /^[1-9]/.test(d)) d = "94" + d;
  if (d.length < 7) return null; // an extension, not a number
  return d;
}

/** The last nine digits, which is what survives every way of writing a number.
 *  Used as a corroborator, never on its own — nine digits collide. */
export function phoneTail(raw: string | null | undefined): string | null {
  const k = phoneKey(raw);
  return k && k.length >= 9 ? k.slice(-9) : null;
}

/** `https://www.linkedin.com/in/nimal-perera-123/?utm_source=share` and
 *  `linkedin.com/in/nimal-perera-123` are the same profile. */
export function linkedinKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  const m = t.match(/linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).replace(/\/+$/, "");
  return slug.length >= 3 ? slug : null;
}

const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "rev", "eng", "er", "hon",
  "mohamed", // never dropped — see below
]);
HONORIFICS.delete("mohamed"); // guard against a careless edit: it is a name here, not a title

/**
 * Name tokens: accents folded, punctuation dropped, honorifics removed,
 * initials kept as single letters so they can be matched against the words
 * they stand for.
 */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s.]/g, " ")
    .replace(/\./g, ". ")
    .split(/\s+/)
    .map((t) => t.replace(/\./g, "").trim())
    .filter((t) => t.length > 0 && !HONORIFICS.has(t));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Two name words count as the same when they are the same word, one is a
 *  short form of the other, or a single letter stands in for it. */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  if (a.startsWith(b) || b.startsWith(a)) return Math.min(a.length, b.length) >= 3;
  const d = levenshtein(a, b);
  return d <= (Math.max(a.length, b.length) >= 6 ? 2 : 1);
}

/**
 * 0–1, symmetric, weighted so the family name carries more than a middle name
 * nobody writes twice.
 *
 * Scored against the SHORTER name: a CV that says "S. Perera" and one that
 * says "Wijesinghe Arachchige Don Sunil Perera" should read as a strong
 * partial match, not a weak one — the second name has not contradicted the
 * first, it has only said more. Scoring against the longer name would push
 * every initials-vs-expansion pair below any usable threshold, which is the
 * common case on this desk rather than the exotic one.
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (A.length === 0 || B.length === 0) return 0;

  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  const used = new Set<number>();
  let hits = 0;
  let initialOnly = 0;

  for (const t of short) {
    const idx = long.findIndex((u, i) => !used.has(i) && tokenMatch(t, u));
    if (idx >= 0) {
      used.add(idx);
      hits++;
      if (t.length === 1 || long[idx].length === 1) initialOnly++;
    }
  }

  let score = hits / short.length;

  // A match carried entirely by initials is not a match — "S. Perera" and
  // "S. Peiris" share an initial and nothing else.
  if (hits > 0 && initialOnly === hits) score *= 0.5;

  // The last token is the family name in every convention the desk sees.
  // Agreement there is worth something on its own; disagreement is a real
  // signal that these are two people.
  const lastA = A[A.length - 1];
  const lastB = B[B.length - 1];
  if (lastA.length > 1 && lastB.length > 1) {
    if (tokenMatch(lastA, lastB)) score = Math.min(1, score + 0.15);
    else score *= 0.6;
  }

  return Math.round(score * 100) / 100;
}

/** Company names arrive with and without the suffix, and with the suffix
 *  spelled six ways. */
export function employerKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(pvt|private|ltd|limited|plc|inc|incorporated|llc|company|co|group|holdings|lanka)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 3 ? t : null;
}

/**
 * Whether two employer strings point at the same place.
 *
 * Exact equality is too strict for how the desk writes companies: the same
 * employer appears as the group, or the group plus the division — "MAS",
 * "MAS Holdings", "MAS Active". So one key standing as a whole-token prefix of
 * the other counts too.
 *
 * That will occasionally relate two subsidiaries of one group, and it is meant
 * to. Employer is only ever a WEAK signal here — the most it can do is put a
 * pair in front of a TA who takes two seconds to say no. Missing a duplicate
 * costs more than that: two records for one person, two TAs working them, and
 * the client receiving the same CV twice.
 */
export function employerRelated(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = employerKey(a);
  const kb = employerKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 3 && (long === short || long.startsWith(short + " "));
}

// ────────────────────────────────────────────────────────────── the verdict ──

export type Verdict = "same" | "review" | "new";

export interface Evidence {
  key: "fileHash" | "email" | "phone" | "linkedin" | "name" | "employer" | "phoneTail";
  detail: string;
  /** Strong evidence can decide on its own; weak evidence only corroborates. */
  strong: boolean;
}

export interface Match {
  verdict: Verdict;
  /** Index into the array that was searched. -1 when the verdict is `new`. */
  index: number;
  evidence: Evidence[];
  /** Why this is not simply `same`, in a sentence a TA can act on. */
  reason: string | null;
}

/** Below this, two names are different people however well the keys line up. */
const NAME_DISAGREES = 0.4;
/** At or above this, two names alone are worth a human look. */
const NAME_SUGGESTS = 0.72;

function strongKeys(x: Identity) {
  return {
    fileHash: x.fileHash?.trim().toLowerCase() || null,
    email: emailKey(x.email),
    phone: phoneKey(x.phone),
    linkedin: linkedinKey(x.linkedinUrl),
  };
}

/**
 * Compare one incoming record against one existing record.
 *
 * The shape of the decision, in order of what it costs to get wrong:
 *   - identical file            → `same`, nothing to think about
 *   - strong key + name agrees  → `same`
 *   - strong key + name differs → `review` (shared phone, recycled address,
 *                                 a typo — all common, all merged silently by
 *                                 the original)
 *   - name agrees + corroborator→ `review`
 *   - otherwise                 → `new`
 */
export function compare(incoming: Identity, existing: Identity): Match {
  const a = strongKeys(incoming);
  const b = strongKeys(existing);
  const evidence: Evidence[] = [];

  if (a.fileHash && a.fileHash === b.fileHash) {
    return {
      verdict: "same",
      index: 0,
      evidence: [{ key: "fileHash", detail: "byte-identical CV file", strong: true }],
      reason: null,
    };
  }

  if (a.email && a.email === b.email) {
    evidence.push({ key: "email", detail: a.email, strong: true });
  }
  if (a.phone && a.phone === b.phone) {
    evidence.push({ key: "phone", detail: `+${a.phone}`, strong: true });
  }
  if (a.linkedin && a.linkedin === b.linkedin) {
    evidence.push({ key: "linkedin", detail: `/in/${a.linkedin}`, strong: true });
  }

  const sim = nameSimilarity(incoming.fullName, existing.fullName);
  if (sim >= NAME_SUGGESTS) {
    evidence.push({ key: "name", detail: `${Math.round(sim * 100)}% name match`, strong: false });
  }

  if (employerRelated(incoming.currentEmployer, existing.currentEmployer)) {
    evidence.push({ key: "employer", detail: existing.currentEmployer ?? "", strong: false });
  }

  const tailA = phoneTail(incoming.phone);
  const tailB = phoneTail(existing.phone);
  if (tailA && tailA === tailB && a.phone !== b.phone) {
    evidence.push({ key: "phoneTail", detail: `…${tailA.slice(-7)}`, strong: false });
  }

  const hasStrong = evidence.some((e) => e.strong);

  if (hasStrong) {
    if (sim >= NAME_DISAGREES) {
      return { verdict: "same", index: 0, evidence, reason: null };
    }
    return {
      verdict: "review",
      index: 0,
      evidence,
      reason: `${evidence.find((e) => e.strong)!.key === "email" ? "The email" : evidence.find((e) => e.strong)!.key === "phone" ? "The phone number" : "The LinkedIn profile"} matches “${existing.fullName}”, but the names do not. A shared number or a recycled address, or one of the two is wrong.`,
    };
  }

  const corroborated = evidence.some((e) => !e.strong && e.key !== "name");
  if (sim >= NAME_SUGGESTS && corroborated) {
    return {
      verdict: "review",
      index: 0,
      evidence,
      reason: `Same name as “${existing.fullName}” with no email, phone or LinkedIn in common. Could be the same person under a second set of contact details, or two people with the same name.`,
    };
  }

  return { verdict: "new", index: -1, evidence: [], reason: null };
}

/**
 * Compare against a whole database and return the best answer.
 *
 * `same` beats `review`; within a verdict, more evidence beats less. The scan
 * is linear here because the standalone store is an array — at connection the
 * three normalised keys become indexes and this becomes three lookups, which
 * is why they are computed on write rather than derived on read.
 */
export function matchAgainst(incoming: Identity, existing: Identity[]): Match {
  let best: Match = { verdict: "new", index: -1, evidence: [], reason: null };
  const rank = (m: Match) => (m.verdict === "same" ? 2 : m.verdict === "review" ? 1 : 0);

  for (let i = 0; i < existing.length; i++) {
    const m = compare(incoming, existing[i]);
    if (m.verdict === "new") continue;
    const better =
      rank(m) > rank(best) ||
      (rank(m) === rank(best) && m.evidence.length > best.evidence.length);
    if (better) best = { ...m, index: i };
    if (best.verdict === "same" && best.evidence.some((e) => e.key === "fileHash")) break;
  }

  return best;
}

/**
 * What a merge is allowed to do to the record already on file.
 *
 * The live version patches the existing candidate with every field the new CV
 * carries, which means a thinner CV blanks a fuller record — and it does that
 * only when the candidate happens to be sitting in `follow_up`; in any other
 * stage the new CV is dropped with a console line and nobody is told. Both
 * halves of that are wrong in the same way: the system is deciding, silently,
 * which version of a person is true.
 *
 * Here a merge only ever FILLS BLANKS. A field that already holds something
 * is left alone and the incoming value is handed back as a conflict for the
 * TA to resolve, so the newer CV is never lost and the older record is never
 * quietly overwritten.
 */
export interface MergePlan<T> {
  fill: Partial<T>;
  conflicts: { field: string; existing: unknown; incoming: unknown }[];
}

export interface MergeOptions<T> {
  /**
   * Fields where the newer file simply wins rather than raising a question.
   * The CV file name is the case this exists for: a returning candidate
   * sending an updated CV is not disagreeing with us about what their CV is
   * called, and holding the older name would mean holding the older document.
   */
  takeNewest?: (keyof T)[];
}

/**
 * Whether two values for a field mean the same thing.
 *
 * Compared through the same normalisation the identity check uses, because
 * otherwise a merge reports a conflict on the very key that proved the two
 * records were one person: `+94 71 519 2993` and `0715192993` are one number,
 * and a note that says otherwise teaches the desk to stop reading notes.
 */
function equivalent(field: string, a: unknown, b: unknown): boolean {
  const A = String(a).trim();
  const B = String(b).trim();
  if (A === B) return true;
  if (field === "phone") return phoneKey(A) !== null && phoneKey(A) === phoneKey(B);
  if (field === "email") return emailKey(A) !== null && emailKey(A) === emailKey(B);
  if (field === "linkedinUrl") return linkedinKey(A) !== null && linkedinKey(A) === linkedinKey(B);
  if (field === "currentEmployer") return employerRelated(A, B);
  return false;
}

export function planMerge<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
  fields: (keyof T)[],
  opts: MergeOptions<T> = {},
): MergePlan<T> {
  const fill: Partial<T> = {};
  const conflicts: { field: string; existing: unknown; incoming: unknown }[] = [];
  const newest = new Set(opts.takeNewest ?? []);

  const empty = (v: unknown) =>
    v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

  for (const f of fields) {
    const inc = incoming[f];
    if (empty(inc)) continue;
    const cur = existing[f];
    if (empty(cur)) {
      fill[f] = inc;
    } else if (Array.isArray(cur) && Array.isArray(inc)) {
      // Lists grow rather than replace — a CV listing three skills should not
      // delete the nine already known.
      const merged = [...new Set([...(cur as unknown[]), ...(inc as unknown[])])];
      if (merged.length > cur.length) fill[f] = merged as T[keyof T];
    } else if (equivalent(String(f), cur, inc)) {
      // The same thing written another way. Keep what is on file; say nothing.
    } else if (newest.has(f)) {
      fill[f] = inc;
    } else {
      conflicts.push({ field: String(f), existing: cur, incoming: inc });
    }
  }

  return { fill, conflicts };
}
