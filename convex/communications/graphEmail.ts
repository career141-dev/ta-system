"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getGraphToken } from "../lib/graphClient";
import { buildStructuredEmailHtml } from "./emailHtml";

export { buildStructuredEmailHtml };

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: Send email via Microsoft Graph
// ─────────────────────────────────────────────────────────────────────────────
export const sendGraphEmail = internalAction({
  args: {
    communicationId: v.id("communications"),
    candidateJobId: v.string(), // applicationId stringified for header
    taEmail: v.string(),        // "from" mailbox — the recruiter's M365 email
    toAddress: v.string(),      // recipient email
    subject: v.string(),
    bodyHtml: v.string(),
  },
  handler: async (ctx, args) => {
    // Check communication status & stage guard — DO NOT send automated follow-up email if candidate moved out of follow_up stage (e.g. to ta_shortlist)
    const commRecord = await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId });
    if (commRecord?.stoppedSequence || commRecord?.deliveryStatus === "failed") {
      console.log(`[Graph Email] Communication ${args.communicationId} was cancelled/stopped. Skipping email delivery.`);
      return;
    }

    if (commRecord?.applicationId) {
      const appRecord = await ctx.runQuery(internal.communications.whatsappOutbound.getApplicationRecord, { applicationId: commRecord.applicationId });
      if (appRecord && appRecord.currentStage !== "follow_up" && appRecord.currentStage !== "ta_shortlist" && appRecord.currentStage !== "matched_candidates") {
        console.log(`[Graph Email] Application ${commRecord.applicationId} is in stage "${appRecord.currentStage}" (not "follow_up", "ta_shortlist", or "matched_candidates"). Aborting Email follow-up delivery.`);
        return;
      }
    }

    // ── Test-mode redirect ─────────────────────────────────────────────────
    const systemSettings = await ctx.runQuery(internal.admin.settings.getInternalSystemSettings);
    const isTestMode = 
      process.env.EMAIL_TEST_MODE === "true" || 
      process.env.OUTREACH_TEST_MODE === "true" || 
      process.env.TEST_MODE === "true" || 
      systemSettings?.testModeEnabled === true;

    const testRecipient = 
      systemSettings?.testEmailAddress ||
      process.env.EMAIL_TEST_RECIPIENT || 
      process.env.TEST_EMAIL_ADDRESS ||
      "sanjaysanjeev2000@gmail.com";

    let targetAddress = args.toAddress;
    let logNote = "";

    if (isTestMode) {
      const candidateEmailNorm = args.toAddress.toLowerCase().trim();
      const testEmailNorm = testRecipient ? testRecipient.toLowerCase().trim() : "";

      if (testEmailNorm && candidateEmailNorm === testEmailNorm) {
        targetAddress = args.toAddress;
        logNote = ` [TEST CANDIDATE]`;
      } else if (testRecipient) {
        targetAddress = testRecipient;
        logNote = ` [REDIRECTED TO TEST: ${testRecipient}]`;
      } else {
        console.warn(`[Graph Email] Test mode active: Suppressed email outreach to real candidate ${args.toAddress}`);
        await ctx.runMutation(
          internal.communications.graphEmailMutations.updateEmailStatus,
          {
            communicationId: args.communicationId,
            status: "failed",
            error:
              "Test mode is active: Automated email outreach to real candidates is suppressed during testing phase.",
          }
        );
        return;
      }
    }

    try {
      const token = await getGraphToken();

      // Resolve the actual sending mailbox & system reply-to inbox
      const systemInbox = process.env.MS_SENDER_EMAIL || process.env.OUTBOUND_EMAIL_SENDER || "job@career141.com";
      let senderEmail: string = systemInbox;

      // CRITICAL: Reply-To MUST always be set to systemInbox (job@career141.com)
      // so candidate replies return directly to the system inbox for AI processing & DB logging.
      const replyToRecipients = [
        {
          emailAddress: { address: systemInbox }
        }
      ];
      console.log(`[Graph Email] Outbound email configured from ${senderEmail} with Reply-To set to ${systemInbox}.`);

      const payload: any = {
        message: {
          subject: args.subject,
          body: {
            contentType: "HTML",
            content: args.bodyHtml,
          },
          toRecipients: [
            {
              emailAddress: { address: targetAddress },
            },
          ],
          internetMessageHeaders: [
            {
              name: "x-c141-candidatejobid",
              value: args.candidateJobId,
            },
          ],
        },
        saveToSentItems: true,
      };

      if (replyToRecipients.length > 0) {
        payload.message.replyTo = replyToRecipients;
      }

      console.log(
        `[Graph Email] Sending email from ${senderEmail} to ${targetAddress}${logNote}`
      );

      const res = await fetch(
        `${GRAPH_BASE}/users/${encodeURIComponent(senderEmail)}/sendMail`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Graph API returned ${res.status}: ${errorText}`);
      }

      // Success — update communication status
      await ctx.runMutation(
        internal.communications.graphEmailMutations.updateEmailStatus,
        {
          communicationId: args.communicationId,
          status: "sent",
        }
      );

      console.log(`[Graph Email] Email sent successfully.`);
    } catch (err: any) {
      console.error("[Graph Email] Failed to send:", err.message);
      await ctx.runMutation(
        internal.communications.graphEmailMutations.updateEmailStatus,
        {
          communicationId: args.communicationId,
          status: "failed",
          error: err.message,
        }
      );
    }
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
  },
  handler: async (_ctx, args) => {
    const token = await getGraphToken();

    // Rich HTML thread reply: create a reply draft (preserves conversation
    // context / In-Reply-To / References headers), patch the HTML body, then send.
    // Falls back to the simple text-comment reply if the draft flow fails.
    if (args.replyHtml) {
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
        const draftId = draft.id;

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

        const sendRes = await fetch(
          `${GRAPH_BASE}/users/${encodeURIComponent(args.taEmail)}/messages/${draftId}/send`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        if (!sendRes.ok) {
          throw new Error(
            `Draft send failed (${sendRes.status}): ${await sendRes.text()}`
          );
        }

        console.log(`[Graph Email] Rich HTML thread reply sent to message ${args.messageId}`);
        return;
      } catch (err: any) {
        console.warn(
          `[Graph Email] Rich HTML reply path failed (${err.message}). Falling back to text reply.`
        );
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
      throw new Error(
        `[Graph Email] Reply failed (${res.status}): ${errorText}`
      );
    }

    console.log(`[Graph Email] Reply sent to message ${args.messageId}`);
  },
});
