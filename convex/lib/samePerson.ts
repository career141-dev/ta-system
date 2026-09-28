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

/** Two employer names are one company: every distinctive word of the shorter is in the longer. */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = companyWords(a);
  const y = companyWords(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w) => long.includes(w));
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
  if (email(p.email) && email(p.email) === email(c.email)) return { strength: "same", reasons: ["Same email"] };
  const phone = phoneKey(p.phone);
  if (phone && phone === phoneKey(c.phone)) return { strength: "same", reasons: ["Same phone number"] };

  const name = compareNames(p.name, c.fullName);
  if (!name) return { strength: "none", reasons: [] };

  const employers = [c.currentEmployer, ...(c.employers ?? [])];
  const employer = employers.find((e) => sameCompany(p.company, e));
  const title = similarTitle(p.title, c.currentTitle);
  const place = samePlace(p.location, c.location);
  const reasons = [
    name === "exact" ? "Same name" : "Same surname, and initials that fit",
    employer ? `Both at ${employer}` : null,
    title ? "Similar job title" : null,
    place ? "Same place" : null,
  ].filter((r): r is string => Boolean(r));

  if (name === "exact" && employer) return { strength: "same", reasons };
  if (employer || title || place) return { strength: "possible", reasons };
  // The same name and nothing else agreeing: two people, as far as we can tell.
  return { strength: "none", reasons };
}
