// convex/ta/dispatchRecord.ts
//
// The outbound row a sender needs before it can send.
//
// Both senders take a `communicationId` rather than a message: the row is
// created first, marked `pending`, and the sender fills in what happened. That
// ordering is deliberate in the original and worth keeping — it means a
// message that fails to send still leaves a record saying it was attempted,
// instead of vanishing.
//
// Split from `dispatch.ts` because that file is a Node action and this is a
// plain mutation; they cannot live in the same module.

import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { Id } from "../_generated/dataModel";

export const createOutbound = internalMutation({
  args: {
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    channel: v.union(v.literal("whatsapp"), v.literal("email")),
    subject: v.optional(v.string()),
    body: v.string(),
    senderId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<Id<"communications">> => {
    return await ctx.db.insert("communications", {
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      direction: "outbound" as const,
      channel: args.channel,
      subject: args.subject,
      body: args.body,
      senderId: args.senderId,
      // Not "agent3": a person wrote this one and pressed send. The
      // distinction matters when somebody later asks whether a candidate was
      // chased by a human or by the sequence.
      senderAgent: undefined,
      deliveryStatus: "pending" as const,
      stoppedSequence: false,
      sentAt: Date.now(),
    });
  },
});

/** Who the recruiter is, for the "from" mailbox an email needs. */
export const senderMailbox = query({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const user = await ctx.db.get(job.primaryRecruiterId);
    return user ? { email: user.email, name: user.fullName } : null;
  },
});
