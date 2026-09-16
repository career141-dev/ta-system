/**
 * The last check before anything leaves for a real person.
 *
 * Test modes live in each sender and differ between them, and some paths
 * bypass them: the WhatsApp template sender had none, the follow-up email had
 * none, and the free-text WhatsApp sender still messages a real candidate who
 * wrote in within 24 hours — on a database restored from production, those are
 * real people. So this sits under all of them, at the call that actually sends.
 *
 * With `C141_OUTBOUND_LOCK=true`, a message, call or tracking event is allowed
 * only to an address or number on the explicit allow-list
 * (`C141_OUTBOUND_ALLOW_PHONES`, `C141_OUTBOUND_ALLOW_EMAILS`, comma-separated).
 * Everything else is suppressed and logged. Unset, it allows everything, so a
 * deployment that has not opted in behaves exactly as before.
 *
 * Set it on every deployment that is not production. The local deployment
 * refuses to start the TA System without it (see src/lib/safety.ts).
 */

export function outboundLocked(): boolean {
  return process.env.C141_OUTBOUND_LOCK === "true";
}

const list = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const digits = (s: string) => s.replace(/\D/g, "");

/** True when a message or call may go to this phone number. */
export function phoneAllowed(to: string | null | undefined): boolean {
  if (!outboundLocked()) return true;
  const d = digits(to ?? "");
  if (d.length < 7) return false;
  // Compared on the last nine digits: the same number is written +94 77…, 94 77…, 077….
  return list("C141_OUTBOUND_ALLOW_PHONES").some((allowed) => {
    const a = digits(allowed);
    return a.length >= 7 && a.slice(-9) === d.slice(-9);
  });
}

/** True when an email may go to every one of these addresses. */
export function emailAllowed(to: string | string[] | null | undefined): boolean {
  if (!outboundLocked()) return true;
  const allowed = new Set(list("C141_OUTBOUND_ALLOW_EMAILS").map((e) => e.toLowerCase()));
  const targets = (Array.isArray(to) ? to : [to ?? ""]).map((e) => e.trim().toLowerCase());
  return targets.length > 0 && targets.every((e) => e && allowed.has(e));
}

/** The line every suppressed send logs, so a test run can count them. */
export function suppressed(channel: string, to: string | null | undefined): string {
  const msg = `[OutboundLock] Suppressed ${channel} to ${to ? to.replace(/.(?=.{4})/g, "•") : "(none)"} — C141_OUTBOUND_LOCK is on and the recipient is not on the allow-list.`;
  console.warn(msg);
  return msg;
}
