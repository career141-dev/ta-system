"use node";

// convex/ta/dispatch.ts
//
// Sending what the TA platform drafted, through the paths that already work.
//
// Nothing here composes a message or decides who to contact. The platform
// decides that — `lib/followup.ts` works out what is still missing and drafts
// the words, and a person presses the button. This only carries it, and it
// carries it through the tuned senders rather than a second implementation:
//
//   outside the 24-hour window  → metaTemplateSender, an approved template
//   inside it                   → whatsappOutbound.sendWhatsApp, free text
//   email                       → graphEmail.sendGraphEmail
//
// Every one of those already knows about the window, the test-mode redirect,
// the stopped-sequence guard and the stage check. Reimplementing any of it
// would mean re-earning all of it.

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

/**
 * Send one follow-up message a TA has approved.
 *
 * Refuses rather than guesses: no candidate, no contact detail, or a candidate
 * who has asked not to be contacted all stop it here with a reason the screen
 * can show.
 */
export const sendFollowUp = action({
  args: {
    actorId: v.string(),
    applicationId: v.id("applications"),
    channel: v.union(v.literal("whatsapp"), v.literal("email")),
    subject: v.optional(v.string()),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<{ sent: boolean; via: string; reason?: string }> => {
    const may = await ctx.runQuery(internal.ta.dispatchRecord.mayDispatch, {
      actorId: args.actorId,
      applicationId: args.applicationId,
    });
    if (!may.ok) return { sent: false, via: args.channel, reason: may.reason };

    const app = await ctx.runQuery(api.applications.applications.getApplication, {
      id: args.applicationId,
    });
    if (!app) return { sent: false, via: args.channel, reason: "That application no longer exists." };

    const candidate = await ctx.runQuery(api.ta.candidates.get, {
      actorId: args.actorId,
      candidateId: app.candidateId,
    });
    if (!candidate) return { sent: false, via: args.channel, reason: "That candidate no longer exists." };

    // Asked not to be contacted is a full stop, whatever the sequence thinks.
    if ((candidate as { doNotContact?: boolean }).doNotContact) {
      return { sent: false, via: args.channel, reason: "This candidate has asked not to be contacted." };
    }

    if (args.channel === "whatsapp") {
      const phone = (candidate as { phone?: string }).phone;
      if (!phone) return { sent: false, via: "whatsapp", reason: "No phone number on file." };
      // sendWhatsApp decides between free text and the re-engagement template
      // by looking at whether the candidate wrote in the last 24 hours. That
      // rule is Meta's and it is already implemented there.
      // The row first, then the send — see dispatchRecord for why.
      const communicationId = await ctx.runMutation(internal.ta.dispatchRecord.createOutbound, {
        candidateId: app.candidateId,
        applicationId: args.applicationId,
        jobId: app.jobId,
        channel: "whatsapp",
        body: args.body,
      });
      await ctx.runAction(internal.communications.whatsappOutbound.sendWhatsApp, {
        communicationId,
        candidateId: app.candidateId,
        jobId: app.jobId,
        body: args.body,
      });
      return { sent: true, via: "whatsapp" };
    }

    const email = (candidate as { email?: string }).email;
    if (!email) return { sent: false, via: "email", reason: "No email address on file." };

    const mailbox = await ctx.runQuery(api.ta.dispatchRecord.senderMailbox, { jobId: app.jobId });
    if (!mailbox) return { sent: false, via: "email", reason: "This opening has no recruiter to send from." };

    const subject = args.subject ?? "Following up on your application";
    const communicationId = await ctx.runMutation(internal.ta.dispatchRecord.createOutbound, {
      candidateId: app.candidateId,
      applicationId: args.applicationId,
      jobId: app.jobId,
      channel: "email",
      subject,
      body: args.body,
    });
    await ctx.runAction(internal.communications.graphEmail.sendGraphEmail, {
      communicationId,
      candidateJobId: String(args.applicationId),
      taEmail: mailbox.email,
      toAddress: email,
      subject,
      // The drafts are plain text; newlines become breaks so the mail reads
      // as it was written rather than as one run-on paragraph.
      bodyHtml: args.body
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .split("\n")
        .join("<br />"),
    });
    return { sent: true, via: "email" };
  },
});

/**
 * Place a screening call.
 *
 * The dispatcher fails closed: with VOICE_ENGINE unset or anything but
 * `livekit` it records that no call was placed and returns, and in test mode
 * it will only dial a configured test recipient. Both of those are its rules,
 * not this wrapper's, and they are why this is safe to expose.
 */
export const startVoiceCall = action({
  args: {
    actorId: v.string(),
    applicationId: v.id("applications"),
    kind: v.optional(v.union(v.literal("intake"), v.literal("follow_up"))),
  },
  handler: async (ctx, args): Promise<{ started: boolean; reason?: string }> => {
    const may = await ctx.runQuery(internal.ta.dispatchRecord.mayDispatch, {
      actorId: args.actorId,
      applicationId: args.applicationId,
    });
    if (!may.ok) return { started: false, reason: may.reason };

    const app = await ctx.runQuery(api.applications.applications.getApplication, {
      id: args.applicationId,
    });
    if (!app) return { started: false, reason: "That application no longer exists." };

    try {
      // The application-aware trigger, not the job-wide one: it records the
      // call against this application, and its own guard refuses a second
      // call while one is already scheduled or in progress — which is what
      // stops a double click dialling somebody twice.
      await ctx.runMutation(api.applications.applications.triggerManualAiCall, {
        applicationId: args.applicationId,
        candidateId: app.candidateId,
        jobId: app.jobId,
      });
      return { started: true };
    } catch (e) {
      // Expected outcomes, not crashes: a call already in flight, a candidate
      // who asked not to be contacted, an unassigned recruiter. The screen
      // shows the reason.
      return { started: false, reason: (e as Error).message };
    }
  },
});
