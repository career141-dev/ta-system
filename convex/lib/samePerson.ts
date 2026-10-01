/**
 * Is this LinkedIn profile a person we already hold a CV for? — 28 Sep, at the
 * owner's request: a headhunted profile must be matched to the candidate we
 * already have, never made into a second record, and never matched to someone
 * else who merely shares the name.
 *
 * Until now a LinkedIn row became a candidate by its LinkedIn address alone,
 * checked only against candidates already loaded for an opening — and CVs
 * rarely carry the address — so nearly every headhunted person became a new,
 * duplicate record.
 *
 * Two answers, never guessed between:
 *   "same"     — certain enough to link without asking: the same LinkedIn
 *                profile, email or phone number; or the same full name and an
 *                employer in common, current or past.
 *   "possible" — the name matches and something else agrees (the title, the
 *                place, or initials with the surname and an employer). A TA
 *                confirms it; the system does not.
 * A candidate whose own LinkedIn profile is a different one is a different
 * person, whatever else matches.
 *
 * Pure, so the rules are tested (tests/sameperson) and shared by the backend
 * search (ta/candidates:findSamePerson) and the app's local store.
 */

export interface Profile {
  linkedinUrl?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  /**
   * Every company on their LinkedIn experience, as the extension read it (1
   * Oct). A CV a year old names their old employer; LinkedIn names both.
   */
  employers?: (string | null | undefined)[];
}

export interface Held {
  fullName?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  currentEmployer?: string | null;
  currentTitle?: string | null;
  location?: string | null;
  /** Every employer in their career, current one included. */
  employers?: (string | null | undefined)[];
}

export interface Verdict {
  strength: "same" | "possible" | "none";
  reasons: string[];
}

/** A LinkedIn profile's own slug, the same whatever country subdomain or trailing bits. */
export function profileSlug(url: string | null | undefined): string | null {
  const m = (url ?? "").trim().match(/(?:^|\/\/|\.)linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

/** The ways the same profile address is written, for an exact-match index. */
export function linkedinVariants(slug: string): string[] {
  const hosts = ["www.linkedin.com", "linkedin.com", "lk.linkedin.com", "in.linkedin.com", "ae.linkedin.com"];
  const out: string[] = [];
  for (const scheme of ["https://", "http://", ""]) {
    for (const h of hosts) for (const tail of ["", "/"]) out.push(`${scheme}${h}/in/${slug}${tail}`);
  }
  return out;
}

/** A phone number's last nine digits: 0771234567 and +94 77 123 4567 are the same line. */
export function phoneKey(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

const HONORIFIC = /\b(mr|mrs|ms|miss|dr|eng|prof|rev|hon)\b\.?/g;

/** A name as words: lowercase, no titles or punctuation. */
export function nameWords(name: string | null | undefined): string[] {
  return (name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(HONORIFIC, " ")
    .replace(/[^a-z\s.]/g, " ")
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

type NameMatch = "exact" | "initials" | null;

/**
 * "Kajan Thiyagamoorthy" and "Thiyagamoorthy Kajan" are exact (order does not
 * matter). "K. Thiyagamoorthy" or "W.M.K. Perera" beside the full name are
 * initials: the surname matches and every initial fits a name. Anything else,
 * including one shared word, is no match.
 */
export function compareNames(a: string | null | undefined, b: string | null | undefined): NameMatch {
  const x = nameWords(a);
  const y = nameWords(b);
  // A single word is not enough to say anyone is anyone.
  if (x.length < 2 || y.length < 2) return null;
  const sx = [...x].sort().join(" ");
  const sy = [...y].sort().join(" ");
  if (sx === sy) return "exact";

  const full = (w: string[]) => w.filter((t) => t.length > 1);
  const initials = (w: string[]) => w.filter((t) => t.length === 1);
  for (const [short, long] of [[x, y], [y, x]]) {
    const shortFull = full(short);
    const longFull = full(long);
    if (!shortFull.length || !initials(short).length) continue;
    // Every full word on the short side appears on the long side…
    if (!shortFull.every((t) => longFull.includes(t))) continue;
    // …and every initial is the first letter of one of the long side's other words.
    const others = longFull.filter((t) => !shortFull.includes(t));
    if (initials(short).every((i) => others.some((t) => t.startsWith(i)))) return "initials";
  }
  return null;
}

const COMPANY_NOISE = /\b(pvt|private|ltd|limited|plc|llc|inc|co|company|group|holdings|the|and|of|lanka|sri)\b/g;
const companyWords = (c: string | null | undefined) =>
  (c ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(COMPANY_NOISE, " ").split(/\s+/).filter((w) => w.length > 1);

/**
 * How closely two employer names agree.
 *
 *   "same"  — the same distinctive words: "SWEN Container Line (Pvt) Ltd" and
 *             "Swen Container Line".
 *   "close" — one name's words all sit inside the other's: "Bank of Ceylon"
 *             and "Commercial Bank of Ceylon". Often a different company, so it
 *             only ever makes a match "possible" (1 Oct: profiles were linked to
 *             the wrong person on exactly this).
 *   null    — no agreement. Generic words ("self employed", "freelance") never agree.
 */
export function companyMatch(a: string | null | undefined, b: string | null | undefined): "same" | "close" | null {
  const x = companyWords(a);
  const y = companyWords(b);
  if (!x.length || !y.length) return null;
  if (x.every((w) => GENERIC_EMPLOYER.has(w)) || y.every((w) => GENERIC_EMPLOYER.has(w))) return null;
  const sx = [...new Set(x)].sort().join(" ");
  const sy = [...new Set(y)].sort().join(" ");
  if (sx === sy) return "same";
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w) => long.includes(w)) ? "close" : null;
}

const GENERIC_EMPLOYER = new Set(["self", "employed", "freelance", "freelancer", "consultant", "independent", "unemployed", "student", "na", "none"]);

/** Two employer names are one company, or one sits inside the other (see companyMatch). */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  return companyMatch(a, b) !== null;
}

/**
 * Do these two names belong to one person, as far as a merge may assume?
 * A shared phone or email is only proof when the names agree too: an agency's
 * number on a scoop CV, a referee's email or a company switchboard are shared
 * by unrelated people, and merging on them put one person's CV on another
 * person's record (1 Oct). No name on either side is no proof.
 */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareNames(a, b) !== null;
}

const TITLE_NOISE = /\b(senior|junior|sr|jr|assistant|associate|executive|officer|of|and|the|at|in|for|lead|head|chief|deputy)\b/g;
const titleWords = (t: string | null | undefined) =>
  (t ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(TITLE_NOISE, " ").split(/\s+/).filter((w) => w.length > 2);

/** The two titles name the same kind of work: a distinctive word in common. */
export function similarTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  const y = new Set(titleWords(b));
  return titleWords(a).some((w) => y.has(w));
}

function samePlace(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const y = new Set((b ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  return x.some((w) => y.has(w));
}

export function samePerson(p: Profile, c: Held): Verdict {
  const slugP = profileSlug(p.linkedinUrl);
  const slugC = profileSlug(c.linkedinUrl);
  if (slugP && slugC) {
    return slugP === slugC ? { strength: "same", reasons: ["Same LinkedIn profile"] } : { strength: "none", reasons: ["A different LinkedIn profile is on their record"] };
  }
  const email = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const phone = phoneKey(p.phone);
  const contact =
    email(p.email) && email(p.email) === email(c.email) ? "Same email"
    : phone && phone === phoneKey(c.phone) ? "Same phone number"
    : null;
  // A shared email or phone is certain only with the name agreeing (1 Oct): on
  // its own it may be an agency's, a referee's or a company's. A TA confirms.
  if (contact) {
    return namesAgree(p.name, c.fullName)
      ? { strength: "same", reasons: [contact, "Same name"] }
      : { strength: "possible", reasons: [contact, p.name ? "but a different name" : "no name to compare"] };
  }

  const name = compareNames(p.name, c.fullName);
  if (!name) return { strength: "none", reasons: [] };

  const employers = [c.currentEmployer, ...(c.employers ?? [])];
  // Their whole LinkedIn history against their whole CV career (1 Oct): a
  // person who has changed jobs since their CV shares a past company, not a
  // current one. The exact company first, then one inside another's name.
  const theirs = [p.company, ...(p.employers ?? [])].filter(Boolean);
  const pair = (kind: "same" | "close") => {
    for (const mine of theirs) for (const e of employers) if (companyMatch(mine, e) === kind) return e;
    return undefined;
  };
  const employer = pair("same") ?? pair("close");
  const employerSame = !!employer && pair("same") !== undefined;
  const title = similarTitle(p.title, c.currentTitle);
  const place = samePlace(p.location, c.location);
  const reasons = [
    name === "exact" ? "Same name" : "Same surname, and initials that fit",
    employer ? `Both at ${employer}` : null,
    title ? "Similar job title" : null,
    place ? "Same place" : null,
  ].filter((r): r is string => Boolean(r));

  if (name === "exact" && employerSame) return { strength: "same", reasons };
  if (employer || title || place) return { strength: "possible", reasons };
  // The same name and nothing else agreeing: two people, as far as we can tell.
  return { strength: "none", reasons };
}

export interface CvSearchHit {
  strength: "same" | "possible" | "name";
  score: number;
  reasons: string[];
}

/**
 * How well a database candidate fits a LinkedIn profile, for the TA's
 * "Find CV" search (1 Oct). Wider than samePerson: a candidate with only the
 * same name, or the same surname, is still shown — lower down — because the
 * TA decides, and a person the matching missed is usually one whose company
 * or title has changed since their CV. Null when nothing ties them, or their
 * record carries a different LinkedIn profile.
 */
export function cvSearchScore(p: Profile, c: Held): CvSearchHit | null {
  const v = samePerson(p, c);
  if (v.strength === "same") return { strength: "same", score: 100, reasons: v.reasons };
  if (v.strength === "possible") return { strength: "possible", score: 60 + 5 * v.reasons.length, reasons: v.reasons };
  if (v.reasons.some((r) => r.startsWith("A different LinkedIn profile"))) return null;
  const name = compareNames(p.name, c.fullName);
  if (name === "exact") return { strength: "name", score: 40, reasons: ["Same name"] };
  if (name === "initials") return { strength: "name", score: 30, reasons: ["Same surname, and initials that fit"] };
  const mine = nameWords(p.name).filter((w) => w.length > 1);
  const theirs = nameWords(c.fullName);
  const surname = mine.at(-1);
  if (surname && mine.length >= 2 && theirs.includes(surname) && mine.some((w) => w !== surname && theirs.includes(w))) {
    return { strength: "name", score: 20, reasons: ["Name partly the same"] };
  }
  return null;
}
