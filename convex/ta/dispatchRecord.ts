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
import { internalMutation, internalQuery } from "../_generated/server";
import { assertJobAccess, requireActor, WORKS_THE_DESK } from "./guard";
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

/** The assigned TA — who shortlisted them, else the primary recruiter — for the "from" mailbox. */
export const senderMailbox = internalQuery({
  args: { jobId: v.id("jobs"), applicationId: v.optional(v.id("applications")) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const app = args.applicationId ? await ctx.db.get(args.applicationId) : null;
    for (const userId of [app?.ownerTaId, job.primaryRecruiterId]) {
      const user = userId ? await ctx.db.get(userId) : null;
      if (user?.email) return { email: user.email, name: user.fullName };
    }
    return null;
  },
});

/**
 * May this person send on, or call about, this application?
 *
 * The dispatch actions run in Node and cannot read the database themselves, so
 * they ask here first. Same rule as every other TA write: an active desk user,
 * assigned to the opening as a recruiter or director — or an admin or TA
 * manager, who work every opening. Returns a reason instead of throwing so the
 * screen can show it.
 */
export const mayDispatch = internalQuery({
  args: { actorId: v.string(), applicationId: v.id("applications") },
  handler: async (ctx, args): Promise<{ ok: true } | { ok: false; reason: string }> => {
    let user;
    try {
      user = await requireActor(ctx, args.actorId);
    } catch {
      return { ok: false, reason: "Sign in again — the person sending could not be identified." };
    }
    const app = await ctx.db.get(args.applicationId);
    if (!app) return { ok: false, reason: "That application no longer exists." };
    try {
      await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    } catch {
      return { ok: false, reason: "You are not on this opening, so you cannot contact its candidates." };
    }
    return { ok: true };
  },
});
