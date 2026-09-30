// convex/lib/refereeCheck.ts
//
// Is this "referee" a person? (30 Sep)
//
// The CV reading sometimes returns the candidate's own duty bullets as
// referees — "Monitored and maintained CCTV and intruder alarm systems across
// all facilities.", "Established and enforced Standard Operating Procedures
// (SOPs) for:" — and the Reference tab listed seven of them. A referee is a
// person: a name that reads like one, and at least one way to know who they
// are (a phone, an email, a company or a job title). Pure, so it is tested.

/** Words a duty line starts with, and a name never does. */
const DUTY_VERBS = new Set([
  "took", "delivered", "established", "screened", "monitored", "handled", "managed", "led", "developed",
  "conducted", "coordinated", "supervised", "maintained", "implemented", "responsible", "ensured", "prepared",
  "planned", "organized", "organised", "controlled", "assisted", "performed", "provided", "oversaw",
  "trained", "reported", "reviewed", "created", "designed", "achieved", "worked", "participated", "served",
  "carried", "executed", "improved", "reduced", "increased", "built", "set", "introduced", "liaised",
]);

export function looksLikePersonName(raw: string | null | undefined): boolean {
  const name = (raw ?? "").trim();
  if (name.length < 3 || name.length > 60) return false;
  // Sentence punctuation, brackets or digits: a line of text, not a name.
  if (/[:;()\[\]{}!?]|\d/.test(name)) return false;
  // A full stop after a whole word ends a sentence; initials ("K. A. Perera") and titles ("Dr.") are fine.
  if (/[a-z]{3,}\.$/i.test(name) && !/^(mrs?|ms|dr|prof|rev|capt|col|maj|gen|lt|eng)\.?$/i.test(name.split(/\s+/).pop()!.replace(/\.$/, ""))) {
    return false;
  }
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 7) return false;
  const first = words[0].replace(/[^a-z]/gi, "").toLowerCase();
  if (DUTY_VERBS.has(first)) return false;
  return true;
}

export function isPlausibleReferee(r: {
  name?: string | null;
  contactNo?: string | null;
  email?: string | null;
  company?: string | null;
  designation?: string | null;
}): boolean {
  if (!looksLikePersonName(r.name)) return false;
  return [r.contactNo, r.email, r.company, r.designation].some((v) => !!(v ?? "").trim());
}
