// convex/lib/graphMail.ts
//
// An email to a person, sent through Microsoft Graph `sendMail`.
//
// Every email the desk sends goes through here: the Day 0 follow-up
// (communications/graphEmail.ts `sendGraphEmail`), the 24-hour reminders
// (communications/emailAgent.ts `sendFollowUpEmail`) and the end-of-day email
// (ta/eodMail.ts). Every outcome comes back as a result with a reason the TA
// System shows, never a row left "pending".
//
// Follow-ups are sent from the assigned TA's own mailbox, so the candidate sees
// their recruiter. If Graph will not send as that mailbox (not in the tenant, or
// not permitted) the message goes from the system inbox instead, and says so.
//
// The gates run first and in this order, as they do everywhere else:
//   1. the outreach gate (lib/outreachSafety.ts) — test mode redirects to the
//      test mailbox, or refuses when none is set; copies are dropped, because a
//      copy cannot be redirected without sending the test mailbox two of them;
//   2. the outbound lock (lib/outboundGuard.ts) — a test deployment sends only
//      to allow-listed addresses, copies included.
//
// No Convex imports: the token getter and fetch are handed in, so this is
// tested with a fake Graph (tests/graphmail.test.ts).

import { emailAllowed, suppressed } from "./outboundGuard";
import { outreachLive, resolveRecipient } from "./outreachSafety";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface MailAttachment {
  name: string;
  contentType: string;
  /** The file, base64-encoded. */
  base64: string;
}

export interface FollowUpMail {
  /** The mailbox it is sent from — must exist in the tenant. */
  from: string | undefined;
  /** Sent from here instead when Graph refuses `from` (403/404). */
  fallbackFrom?: string;
  /** The recipient. The gate decides where it actually goes. */
  to: string;
  /** More people on the To line, beside `to`. Gated like Cc: dropped in test mode. */
  alsoTo?: string[];
  cc?: string[];
  subject: string;
  html?: string;
  text?: string;
  /** Where replies go. One address or several. */
  replyTo?: string | string[];
  /** Written as `x-c141-candidatejobid`, so a reply can be tied to its application. */
  candidateJobId?: string;
  attachments?: MailAttachment[];
  /**
   * Create a draft and attach every file separately before sending it. EOD
   * uses this because Graph's one-request sendMail payload cannot carry a
   * normal five-CV set; candidate follow-ups keep the smaller inline path.
   */
  attachmentMode?: "inline" | "draft";
  /** In test mode, the env var naming this email's own test mailbox (e.g. EOD_TEST_EMAIL). */
  testInbox?: string;
  /**
   * In test mode, recipients at this domain still get the email beside the test
   * mailbox. Only for mail that never goes to a candidate — the end-of-day email
   * goes to the desk, and a test send that reached only the test inbox left the
   * desk unable to check it (30 Sep). The outbound lock still applies.
   */
  keepInternalInTest?: string;
}

export type MailResult =
  | { ok: true; to: string; alsoTo?: string[]; from: string; cc: string[]; note: string }
  | { ok: false; error: string; blocked: boolean };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
// Microsoft recommends byte ranges below 4 MB. Three MiB also keeps the
// request comfortably below intermediary limits and makes every range except
// the last the same size.
const ATTACHMENT_CHUNK = 3 * 1024 * 1024;

function graphError(stage: string, from: string, status: number, body: string) {
  return `Microsoft Graph ${stage} from ${from} returned ${status}: ${body.slice(0, 500)}`;
}

async function sendDraftWithAttachments(
  mail: FollowUpMail,
  from: string,
  to: string,
  cc: string[],
  alsoTo: string[],
  token: string,
  fetchImpl: FetchLike,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const message = sendMailPayload({ ...mail, attachments: undefined }, to, cc, alsoTo).message;
  const created = await fetchImpl(`${GRAPH_BASE}/users/${encodeURIComponent(from)}/messages`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(message),
  });
  if (!created.ok) return { ok: false, status: created.status, error: graphError("draft creation", from, created.status, await created.text()) };
  let draftId = "";
  try {
    draftId = String(JSON.parse(await created.text()).id ?? "");
  } catch {
    // Handled by the explicit error below so the user sees the failed stage.
  }
  if (!draftId) return { ok: false, status: 502, error: `Microsoft Graph created an email draft from ${from} without returning its ID.` };
  const draft = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/messages/${encodeURIComponent(draftId)}`;

  for (const attachment of mail.attachments ?? []) {
    const bytes = Uint8Array.from(Buffer.from(attachment.base64, "base64"));
    if (bytes.byteLength < SIMPLE_ATTACHMENT_LIMIT) {
      const added = await fetchImpl(`${draft}/attachments`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.name,
          contentType: attachment.contentType,
          contentBytes: attachment.base64,
        }),
      });
      if (!added.ok) return { ok: false, status: added.status, error: graphError(`attachment upload for ${attachment.name}`, from, added.status, await added.text()) };
      continue;
    }

    const session = await fetchImpl(`${draft}/attachments/createUploadSession`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: attachment.name, size: bytes.byteLength } }),
    });
    if (!session.ok) return { ok: false, status: session.status, error: graphError(`upload-session creation for ${attachment.name}`, from, session.status, await session.text()) };
    let uploadUrl = "";
    try {
      uploadUrl = String(JSON.parse(await session.text()).uploadUrl ?? "");
    } catch {
      // Handled below.
    }
    if (!uploadUrl) return { ok: false, status: 502, error: `Microsoft Graph did not return an upload URL for ${attachment.name}.` };
    for (let start = 0; start < bytes.byteLength; start += ATTACHMENT_CHUNK) {
      const end = Math.min(start + ATTACHMENT_CHUNK, bytes.byteLength) - 1;
      const chunk = bytes.slice(start, end + 1);
      const uploaded = await fetchImpl(uploadUrl, {
        method: "PUT",
        // The upload URL is pre-authenticated; Graph explicitly forbids the
        // bearer header on these PUT requests.
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
        },
        body: chunk,
      });
      if (!uploaded.ok) return { ok: false, status: uploaded.status, error: graphError(`byte upload for ${attachment.name}`, from, uploaded.status, await uploaded.text()) };
    }
  }

  const sent = await fetchImpl(`${draft}/send`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!sent.ok) return { ok: false, status: sent.status, error: graphError("draft send", from, sent.status, await sent.text()) };
  return { ok: true };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string | null | undefined) => EMAIL.test((s ?? "").trim());

/** Addresses, trimmed, lower-cased, valid and once each, leaving out any in `except`. */
export function addressList(values: (string | null | undefined)[], except: string[] = []): string[] {
  const skip = new Set(except.map((e) => e.trim().toLowerCase()));
  const out: string[] = [];
  for (const v of values) {
    const a = (v ?? "").trim().toLowerCase();
    if (!isEmail(a) || skip.has(a) || out.includes(a)) continue;
    out.push(a);
  }
  return out;
}

/** The `sendMail` request body. */
export function sendMailPayload(mail: FollowUpMail, to: string, cc: string[] = [], alsoTo: string[] = []) {
  const message: Record<string, unknown> = {
    subject: mail.subject,
    body: mail.html ? { contentType: "HTML", content: mail.html } : { contentType: "Text", content: mail.text ?? "" },
    toRecipients: [to, ...alsoTo].map((address) => ({ emailAddress: { address } })),
  };
  if (cc.length) message.ccRecipients = cc.map((address) => ({ emailAddress: { address } }));
  const replyTo = addressList(Array.isArray(mail.replyTo) ? mail.replyTo : [mail.replyTo]);
  if (replyTo.length) message.replyTo = replyTo.map((address) => ({ emailAddress: { address } }));
  if (mail.candidateJobId) {
    message.internetMessageHeaders = [{ name: "x-c141-candidatejobid", value: mail.candidateJobId }];
  }
  if (mail.attachments?.length) {
    message.attachments = mail.attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType,
      contentBytes: a.base64,
    }));
  }
  return { message, saveToSentItems: true };
}

export async function sendFollowUpMail(
  mail: FollowUpMail,
  getToken: () => Promise<string | null>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<MailResult> {
  const decision = resolveRecipient("email", mail.to, mail.testInbox);
  if (!decision.ok) return { ok: false, error: decision.reason, blocked: true };
  if (!emailAllowed(decision.to)) return { ok: false, error: suppressed("email", decision.to), blocked: true };

  let note = decision.note;
  let alsoTo = addressList(mail.alsoTo ?? [], [decision.to]);
  let cc = addressList(mail.cc ?? [], [decision.to, ...alsoTo]);
  if (!outreachLive()) {
    const domain = (mail.keepInternalInTest ?? "").trim().toLowerCase().replace(/^@/, "");
    const internal = (a: string) => !!domain && a.endsWith(`@${domain}`);
    const wanted = [...alsoTo, ...cc];
    // The intended recipient was swapped for the test mailbox; an internal one
    // still gets it, on the To line.
    const intended = addressList([mail.to], [decision.to]).filter(internal);
    alsoTo = addressList([...intended, ...alsoTo.filter(internal)], [decision.to]);
    cc = cc.filter(internal).filter((c) => !alsoTo.includes(c));
    const dropped = wanted.filter((a) => !alsoTo.includes(a) && !cc.includes(a)).length;
    if (dropped) note += ` [TEST MODE: ${dropped} extra recipient${dropped === 1 ? "" : "s"} dropped]`;
    if (alsoTo.length || cc.length) note += ` [TEST MODE: the ${domain} recipients get it too]`;
  }
  const toBlocked = alsoTo.filter((c) => !emailAllowed(c));
  if (toBlocked.length) {
    for (const c of toBlocked) suppressed("email to", c);
    alsoTo = alsoTo.filter((c) => emailAllowed(c));
  }
  const ccBlocked = cc.filter((c) => !emailAllowed(c));
  if (ccBlocked.length) {
    for (const c of ccBlocked) suppressed("email cc", c);
    cc = cc.filter((c) => emailAllowed(c));
  }
  // Said on screen, not only in the server log: an end-of-day email whose Cc
  // were all held back by the lock showed a plain "Sent", and the desk found
  // out from the people who never got it (1 Oct).
  const held = [...toBlocked, ...ccBlocked];
  if (held.length) {
    note += ` [OUTBOUND LOCK: not sent to ${held.join(", ")} — not on C141_OUTBOUND_ALLOW_EMAILS]`;
  }

  const first = (mail.from ?? "").trim();
  const fallback = (mail.fallbackFrom ?? "").trim();
  const senders = addressList([first, fallback]);
  if (!senders.length) {
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

  const body = JSON.stringify(sendMailPayload(mail, decision.to, cc, alsoTo));
  let lastError = "";
  for (const [i, from] of senders.entries()) {
    try {
      if (mail.attachmentMode === "draft" && mail.attachments?.length) {
        const draft = await sendDraftWithAttachments(mail, from, decision.to, cc, alsoTo, token, fetchImpl);
        if (draft.ok) {
          return { ok: true, to: decision.to, alsoTo, from, cc, note: i > 0 ? `${note} [sent from ${from}: ${senders[0]} could not send]` : note };
        }
        lastError = draft.error;
        if (draft.status !== 403 && draft.status !== 404) break;
        continue;
      }
      const res = await fetchImpl(`${GRAPH_BASE}/users/${encodeURIComponent(from)}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      // Graph answers 202 Accepted with an empty body.
      if (res.ok) {
        return { ok: true, to: decision.to, alsoTo, from, cc, note: i > 0 ? `${note} [sent from ${from}: ${senders[0]} could not send]` : note };
      }
      lastError = `Microsoft Graph sendMail from ${from} returned ${res.status}: ${(await res.text()).slice(0, 500)}`;
      // Only a mailbox Graph will not send as is worth trying the fallback for.
      if (res.status !== 403 && res.status !== 404) break;
    } catch (e) {
      lastError = `Microsoft Graph could not be reached: ${(e as Error).message}`;
      break;
    }
  }
  return { ok: false, error: lastError, blocked: false };
}

/**
 * Whether a follow-up message that was queued should still go.
 * Null means send it; otherwise the reason it is not sent.
 */
export function followUpCancelledReason(
  comm: { stoppedSequence?: boolean; deliveryStatus?: string } | null,
  app: { currentStage?: string } | null,
  /**
   * The message answers the candidate rather than chasing them.
   *
   * The point of this guard is that a chase must not reach somebody who has
   * moved on. An answer is the opposite: the assistant collects the last
   * detail, the candidate is advanced to Second Shortlist in the same breath,
   * and the "thank you, your profile is complete" note was then cancelled for
   * being sent to a candidate no longer in Follow-up (18 September). The
   * candidate heard nothing back at exactly the moment they had done what was
   * asked.
   */
  isReplyToCandidate = false,
): string | null {
  if (comm?.stoppedSequence || comm?.deliveryStatus === "failed") return "Follow-up was stopped before this message went.";
  if (isReplyToCandidate) return null;
  const stage = app?.currentStage;
  if (stage && stage !== "follow_up" && stage !== "ta_shortlist" && stage !== "matched_candidates") {
    return `Cancelled: the candidate is no longer in Follow-up (${stage}).`;
  }
  return null;
}
