/**
 * Whether a message the page is showing reports a success, a failure, or
 * something in between.
 *
 * Server actions say so with `?tone=` (see `back`, `fail` and `note` in
 * app/actions.ts). About thirty older redirects build `?msg=` by hand and carry
 * no tone; for those the wording decides, so "Not sent: …" is never shown in
 * the same green as "Saved." An explicit tone always wins.
 */
export type FlashTone = "ok" | "error" | "note";

const FAILURE = [
  /\bcould not\b/i, /\bcannot\b/i, /\bcan['’]t\b/i, /\bnot sent\b/i, /\bnot yet\b/i,
  /\bno longer\b/i, /\bfailed\b/i, /\brefused\b/i, /\bis not\b/i, /\bisn['’]t\b/i,
  /\bnot an?\b/i, /\bmissing\b/i, /\brequired\b/i, /^\s*only (a|an|the)\b/i,
  /^\s*(pick|enter|paste|tick|say|choose|add at least)\b/i, /\bneeds? (a|an|the|at least)\b/i,
  /\bfirst\.\s*$/i, /\berror\b/i,
];
const IN_BETWEEN = [/^\s*already\b/i, /\bnot due\b/i, /\bnothing is owed\b/i, /\bbut not\b/i];

export function flashTone(message: string, tone?: string | null): FlashTone {
  if (tone === "ok" || tone === "error" || tone === "note") return tone;
  if (IN_BETWEEN.some((re) => re.test(message))) return "note";
  if (FAILURE.some((re) => re.test(message))) return "error";
  return "ok";
}
