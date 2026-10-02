// convex/lib/outreachSafety.ts
//
// The one gate every message to a person passes through.
//
// Why this exists: the senders each had their own idea of "test mode" — env
// flags, a database toggle, a hardcoded Gmail fallback — and several had none
// at all (the Meta template sender, the follow-up nudge email, the thread
// reply). A deployment restored from production, with production credentials,
// could therefore message real candidates from a laptop.
//
// The rule here is FAIL CLOSED:
//
//   OUTREACH_LIVE=true      → messages go to the intended person.
//   anything else (default) → messages go ONLY to the test recipient
//                             (OUTREACH_TEST_EMAIL / OUTREACH_TEST_PHONE), and
//                             are blocked outright when that is not set.
//
// Deliberately env-only, and deliberately not the `appSettings.testModeEnabled`
// row: that row travels with a database backup, so a restore would carry
// production's "live" into a development machine. The environment belongs to
// the machine.
//
// Import it at the lowest level — the function that makes the HTTP call — so a
// new caller cannot route around it.

export type OutreachChannel = "email" | "whatsapp";

export type RecipientDecision =
  | { ok: true; to: string; redirected: boolean; note: string }
  | { ok: false; reason: string };

export function outreachLive(): boolean {
  return (process.env.OUTREACH_LIVE ?? "").trim().toLowerCase() === "true";
}

const digits = (s: string) => s.replace(/[^0-9]/g, "");

/**
 * A phone number as WhatsApp needs it: country code first, no "+" or "00".
 *
 * CVs and Excel Tables hold Sri Lankan numbers the local way — "0703205525" —
 * which WhatsApp cannot deliver to (21 Sep). A ten-digit number starting 0 is
 * read as Sri Lankan (OUTREACH_DEFAULT_COUNTRY_CODE, 94 unless set); "0094…"
 * loses its 00. Anything else is kept as its digits.
 */
export function internationalPhone(raw: string): string {
  let d = digits(raw);
  if (d.startsWith("00")) d = d.slice(2);
  const cc = (process.env.OUTREACH_DEFAULT_COUNTRY_CODE ?? "94").replace(/\D/g, "") || "94";
  if (/^0\d{9}$/.test(d)) d = cc + d.slice(1);
  return d;
}
const emailNorm = (s: string) => s.trim().toLowerCase();

/**
 * `testInbox` names a separate test mailbox for one kind of email. The
 * end-of-day email uses EOD_TEST_EMAIL, so the Director's shortlist can be
 * checked in a different inbox from the candidate follow-ups (24 Sep). Unset,
 * it falls back to OUTREACH_TEST_EMAIL.
 */
function testRecipient(channel: OutreachChannel, testInbox?: string): string {
  const own = channel === "email" && testInbox ? (process.env[testInbox] ?? "").trim() : "";
  const raw = own || (channel === "email" ? process.env.OUTREACH_TEST_EMAIL : process.env.OUTREACH_TEST_PHONE);
  const value = (raw ?? "").trim();
  if (!value) return "";
  return channel === "email" ? emailNorm(value) : internationalPhone(value);
}

/**
 * What happens to a message on this channel right now, for screens that should
 * say so before the click: sent to the candidate, redirected to the test
 * recipient, or stopped. Reads the same settings as resolveRecipient; decides
 * nothing itself.
 */
export function deliveryMode(channel: OutreachChannel): "live" | "test" | "off" {
  if (outreachLive()) return "live";
  return testRecipient(channel) ? "test" : "off";
}

/**
 * Who a message may actually be delivered to.
 *
 * `intended` is the candidate's address or phone. In test mode the message is
 * redirected to the test recipient (and says so in `note`); with no test
 * recipient configured it is refused.
 */
export function resolveRecipient(channel: OutreachChannel, intended: string, testInbox?: string): RecipientDecision {
  const want = channel === "email" ? emailNorm(intended ?? "") : internationalPhone(intended ?? "");
  if (outreachLive()) {
    if (!want) return { ok: false, reason: `No ${channel === "email" ? "email address" : "phone number"} to send to.` };
    return { ok: true, to: want, redirected: false, note: "" };
  }
  const test = testRecipient(channel, testInbox);
  if (!test) {
    return {
      ok: false,
      reason:
        `Test mode: blocked a ${channel} message because no test recipient is set ` +
        `(${channel === "email" ? "OUTREACH_TEST_EMAIL" : "OUTREACH_TEST_PHONE"}). Real candidates are never messaged unless OUTREACH_LIVE=true.`,
    };
  }
  if (want && want === test) return { ok: true, to: test, redirected: false, note: " [TEST RECIPIENT]" };
  return { ok: true, to: test, redirected: true, note: ` [TEST MODE: redirected from ${want || "unknown"}]` };
}

/**
 * For replies that cannot be redirected — a Graph thread reply goes to whoever
 * wrote the original message. In test mode it is allowed only when that person
 * IS the test recipient.
 */
export function mayReplyTo(channel: OutreachChannel, originalSender: string | undefined): RecipientDecision {
  if (outreachLive()) return { ok: true, to: originalSender ?? "", redirected: false, note: "" };
  const test = testRecipient(channel);
  const who = channel === "email" ? emailNorm(originalSender ?? "") : digits(originalSender ?? "");
  if (test && who && who === test) return { ok: true, to: who, redirected: false, note: " [TEST RECIPIENT]" };
  return {
    ok: false,
    reason: `Test mode: blocked a thread reply to ${who || "an unknown sender"} — only the test recipient may be replied to.`,
  };
}

/**
 * Why a message or call must not go to this person, or null when it may.
 *
 * `records` is every candidate record the recipient matches — by id, by email
 * and by phone — because the same person sits on several records (CVs, Excel
 * Tables, headhunting) and the do-not-contact flag is set on only one of them.
 * One flagged record is enough: someone who asked us to stop asked once.
 *
 * Until 2 Oct only the follow-up cron, the TA desk's dispatch and the voice
 * paths looked at the flag. The stage machine's automatic Day 0 outreach, the
 * Graph emails, the WhatsApp sender, the Meta templates and the AI's replies
 * to inbound messages all went to a candidate who had asked not to be
 * contacted. Every one of those now asks contactGuard.ts, which asks this.
 */
export function doNotContactRefusal(
  records: ({ doNotContact?: boolean; doNotContactReason?: string } | null | undefined)[],
): string | null {
  const flagged = records.find((r) => r?.doNotContact === true);
  if (!flagged) return null;
  const why = (flagged.doNotContactReason ?? "").trim();
  return `Not sent: the candidate is marked do-not-contact${why ? ` (${why})` : ""}.`;
}
