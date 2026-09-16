// convex/lib/graphMail.ts
//
// A follow-up email, sent through Microsoft Graph `sendMail`.
//
// Both follow-up senders go through here — the Day 0 email
// (communications/graphEmail.ts `sendGraphEmail`) and the 24-hour reminders
// (communications/emailAgent.ts `sendFollowUpEmail`). They used to build the
// request separately and fail differently: a reminder with no Graph
// credentials was marked failed with no reason, and one whose mailbox was not
// configured threw and stayed "pending" for ever. Here every outcome comes back
// as a result with a reason the TA System shows.
//
// The gates run first and in this order, as they do everywhere else:
//   1. the outreach gate (lib/outreachSafety.ts) — test mode redirects to the
//      test mailbox, or refuses when none is set;
//   2. the outbound lock (lib/outboundGuard.ts) — a test deployment sends only
//      to allow-listed addresses.
//
// No Convex imports: the token getter and fetch are handed in, so this is
// tested with a fake Graph (tests/graphmail.test.ts).

import { emailAllowed, suppressed } from "./outboundGuard";
import { resolveRecipient } from "./outreachSafety";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface FollowUpMail {
  /** The mailbox it is sent from — must exist in the tenant. */
  from: string | undefined;
  /** The candidate's address. The gate decides where it actually goes. */
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** Where replies go — the system inbox that is polled for follow-up replies. */
  replyTo?: string;
  /** Written as `x-c141-candidatejobid`, so a reply can be tied to its application. */
  candidateJobId?: string;
}

export type MailResult =
  | { ok: true; to: string; note: string }
  | { ok: false; error: string; blocked: boolean };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** The `sendMail` request body. */
export function sendMailPayload(mail: FollowUpMail, to: string) {
  const message: Record<string, unknown> = {
    subject: mail.subject,
    body: mail.html ? { contentType: "HTML", content: mail.html } : { contentType: "Text", content: mail.text ?? "" },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (mail.replyTo) message.replyTo = [{ emailAddress: { address: mail.replyTo } }];
  if (mail.candidateJobId) {
    message.internetMessageHeaders = [{ name: "x-c141-candidatejobid", value: mail.candidateJobId }];
  }
  return { message, saveToSentItems: true };
}

export async function sendFollowUpMail(
  mail: FollowUpMail,
  getToken: () => Promise<string | null>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<MailResult> {
  const decision = resolveRecipient("email", mail.to);
  if (!decision.ok) return { ok: false, error: decision.reason, blocked: true };
  if (!emailAllowed(decision.to)) return { ok: false, error: suppressed("follow-up email", decision.to), blocked: true };

  const from = (mail.from ?? "").trim();
  if (!from) {
    return { ok: false, error: "No sending mailbox is configured (MS_SENDER_EMAIL or OUTBOUND_EMAIL_SENDER).", blocked: false };
  }

  let token: string | null;
  try {
    token = await getToken();
  } catch (e) {
    return { ok: false, error: `Microsoft Graph sign-in failed: ${(e as Error).message}`, blocked: false };
  }
  if (!token) {
    return { ok: false, error: "Microsoft Graph credentials are not configured (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET).", blocked: false };
  }

  try {
    const res = await fetchImpl(`${GRAPH_BASE}/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(sendMailPayload(mail, decision.to)),
    });
    // Graph answers 202 Accepted with an empty body.
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      return { ok: false, error: `Microsoft Graph sendMail returned ${res.status}: ${body}`, blocked: false };
    }
  } catch (e) {
    return { ok: false, error: `Microsoft Graph could not be reached: ${(e as Error).message}`, blocked: false };
  }
  return { ok: true, to: decision.to, note: decision.note };
}

/**
 * Whether a follow-up message that was queued should still go.
 * Null means send it; otherwise the reason it is not sent.
 */
export function followUpCancelledReason(
  comm: { stoppedSequence?: boolean; deliveryStatus?: string } | null,
  app: { currentStage?: string } | null,
): string | null {
  if (comm?.stoppedSequence || comm?.deliveryStatus === "failed") return "Follow-up was stopped before this message went.";
  const stage = app?.currentStage;
  if (stage && stage !== "follow_up" && stage !== "ta_shortlist" && stage !== "matched_candidates") {
    return `Cancelled: the candidate is no longer in Follow-up (${stage}).`;
  }
  return null;
}
