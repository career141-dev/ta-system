"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getGraphToken } from "../lib/graphClient";
import { buildStructuredEmailHtml } from "./emailHtml";
import { emailAllowed, phoneAllowed, outboundLocked, suppressed } from "../lib/outboundGuard";
import { mayReplyTo } from "../lib/outreachSafety";
import { followUpCancelledReason, isEmail, sendFollowUpMail } from "../lib/graphMail";
import { refuseIfDoNotContact } from "../lib/doNotContact";

export { buildStructuredEmailHtml };

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: Send email via Microsoft Graph
// ─────────────────────────────────────────────────────────────────────────────
export const sendGraphEmail = internalAction({
  args: {
    communicationId: v.id("communications"),
    candidateJobId: v.string(), // applicationId stringified for header
    taEmail: v.string(),        // the assigned TA's mailbox it is sent from (system inbox when blank)
    toAddress: v.string(),      // recipient email
    subject: v.string(),
    bodyHtml: v.string(),
    /** An answer to something the candidate sent, not a chase (see followUpCancelledReason). */
    isReplyToCandidate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Not sent if the sequence was stopped or the candidate left Follow-up —
    // and the row says so, rather than staying "pending".
    const commRecord = await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId });
    const appRecord = commRecord?.applicationId
      ? await ctx.runQuery(internal.communications.whatsappOutbound.getApplicationRecord, { applicationId: commRecord.applicationId })
      : null;
    const cancelled =
      followUpCancelledReason(commRecord, appRecord, args.isReplyToCandidate === true) ??
      (await refuseIfDoNotContact(ctx, "email", { candidateId: commRecord?.candidateId, email: args.toAddress }));
    if (cancelled) {
      console.log(`[Graph Email] ${cancelled} (communication ${args.communicationId})`);
      if (commRecord?.deliveryStatus !== "failed") {
        await ctx.runMutation(internal.communications.graphEmailMutations.updateEmailStatus, {
          communicationId: args.communicationId,
          status: "failed",
          error: cancelled,
        });
      }
      return;
    }

    // Sent from the assigned TA's own mailbox, so the candidate sees their
    // recruiter. Replies go to the TA and to the system inbox (job@), which is
    // polled for follow-up replies and read into the record.
    const systemInbox = process.env.MS_SENDER_EMAIL || process.env.OUTBOUND_EMAIL_SENDER || "job@career141.com";
    const taMailbox = isEmail(args.taEmail) ? args.taEmail.trim() : systemInbox;
    const result = await sendFollowUpMail(
      {
        from: taMailbox,
        fallbackFrom: systemInbox,
        to: args.toAddress,
        subject: args.subject,
        html: args.bodyHtml,
        replyTo: [taMailbox, systemInbox],
        candidateJobId: args.candidateJobId,
      },
      getGraphToken,
    );

    if (result.ok) {
      console.log(`[Graph Email] Sent via Microsoft Graph from ${result.from} to ${result.to}${result.note}`);
    } else {
      console.error(`[Graph Email] Not sent: ${result.error}`);
    }
    await ctx.runMutation(internal.communications.graphEmailMutations.updateEmailStatus, {
      communicationId: args.communicationId,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? undefined : result.error,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: Read latest inbox messages for a given mailbox
// ─────────────────────────────────────────────────────────────────────────────
export const readInboxMessages = internalAction({
  args: {
    taEmail: v.string(),
    top: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    const token = await getGraphToken();
    const count = args.top ?? 25;

    const selectFields = [
      "id",
      "subject",
      "from",
      "receivedDateTime",
      "bodyPreview",
      "internetMessageHeaders",
      "isRead",
    ].join(",");

    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(args.taEmail)}` +
      `/mailFolders/inbox/messages` +
      `?$top=${count}&$orderby=receivedDateTime desc&$select=${selectFields}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `[Graph Email] Inbox read failed (${res.status}): ${errorText}`
      );
    }

    const data = await res.json();
    return data.value as any[];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: Reply to a specific message
// ─────────────────────────────────────────────────────────────────────────────
export const replyToMessage = internalAction({
  args: {
    taEmail: v.string(),
    messageId: v.string(),
    replyText: v.string(),
    replyHtml: v.optional(v.string()),
    /** Who wrote the message being replied to — a thread reply goes to them. */
    originalSender: v.optional(v.string()),
    /**
     * The row this reply was written into, so a refusal is visible.
     *
     * Both gates below used to return silently: on a locked deployment the
     * assistant's answer simply never existed, while the candidate page said
     * it had replied (18 September). The row is now marked failed with the
     * reason, which is what the conversation shows.
     */
    communicationId: v.optional(v.id("communications")),
  },
  handler: async (ctx, args) => {
    const refuse = async (reason: string) => {
      console.warn(`[Graph Email] ${reason}`);
      if (args.communicationId) {
        await ctx.runMutation(internal.communications.graphEmailMutations.updateEmailStatus, {
          communicationId: args.communicationId,
          status: "failed",
          error: reason,
        });
      }
    };
    // Two gates, both must allow it. A reply goes to whoever wrote the original,
    // which this cannot see without fetching it, so while the outbound lock is on
    // (a test deployment) replies are not sent at all. Otherwise the fail-closed
    // outreach rule applies: in test mode only to the test recipient, and a
    // caller that cannot say who it replies to is refused.
    if (outboundLocked()) {
      suppressed("email reply", `message ${args.messageId}`);
      await refuse(`Not sent: the outbound lock is on, and a thread reply cannot be redirected to the test recipient.`);
      return;
    }
    const decision = mayReplyTo("email", args.originalSender);
    if (!decision.ok) {
      await refuse(decision.reason);
      return;
    }
    const comm = args.communicationId
      ? await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId })
      : null;
    const doNotContact = await refuseIfDoNotContact(ctx, "email reply", {
      candidateId: comm?.candidateId,
      email: args.originalSender,
    });
    if (doNotContact) {
      await refuse(doNotContact);
      return;
    }
    const markSent = async () => {
      if (args.communicationId) {
        await ctx.runMutation(internal.communications.graphEmailMutations.updateEmailStatus, {
          communicationId: args.communicationId,
          status: "sent",
        });
      }
    };
    const token = await getGraphToken();

    // Rich HTML thread reply: create a reply draft (preserves conversation
    // context / In-Reply-To / References headers), patch the HTML body, then send.
    //
    // Falls back to the plain /reply ONLY when the draft could not be made or
    // filled in — then nothing has gone. Once /send has been called, a timeout
    // or a 5xx does not prove Graph did not send it, and falling back sent the
    // candidate the same answer twice (2 Oct). A failed send is now logged and
    // left, not resent.
    if (args.replyHtml) {
      let draftId: string | null = null;
      try {
        const createReplyRes = await fetch(
          `${GRAPH_BASE}/users/${encodeURIComponent(args.taEmail)}/messages/${args.messageId}/createReply`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }
        );

        if (!createReplyRes.ok) {
          throw new Error(
            `createReply failed (${createReplyRes.status}): ${await createReplyRes.text()}`
          );
        }

        const draft = await createReplyRes.json();
        draftId = draft.id as string;

        const patchRes = await fetch(
          `${GRAPH_BASE}/users/${encodeURIComponent(args.taEmail)}/messages/${draftId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              body: { contentType: "html", content: args.replyHtml },
            }),
          }
        );

        if (!patchRes.ok) {
          throw new Error(
            `Draft body patch failed (${patchRes.status}): ${await patchRes.text()}`
          );
        }
      } catch (err: any) {
        draftId = null;
        console.warn(
          `[Graph Email] Rich HTML reply draft failed (${err.message}). Nothing was sent; falling back to text reply.`
        );
      }

      if (draftId) {
        let sendError: string | null = null;
        try {
          const sendRes = await fetch(
            `${GRAPH_BASE}/users/${encodeURIComponent(args.taEmail)}/messages/${draftId}/send`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          if (!sendRes.ok) sendError = `Draft send failed (${sendRes.status}): ${await sendRes.text()}`;
        } catch (err: any) {
          sendError = `Draft send did not answer: ${err.message}`;
        }
        if (sendError) {
          await refuse(
            `${sendError}. Not retried — Graph may already have sent it, and a second try would reach the candidate twice. Check the mailbox's Sent Items.`,
          );
          return;
        }
        console.log(`[Graph Email] Rich HTML thread reply sent to message ${args.messageId}`);
        await markSent();
        return;
      }
    }

    const res = await fetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(args.taEmail)}/messages/${args.messageId}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: args.replyText,
        }),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      await refuse(`Reply failed (${res.status}): ${errorText.slice(0, 500)}`);
      return;
    }

    console.log(`[Graph Email] Reply sent to message ${args.messageId}`);
    await markSent();
  },
});
