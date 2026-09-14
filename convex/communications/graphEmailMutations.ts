import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION: Update email communication delivery status
// ─────────────────────────────────────────────────────────────────────────────
export const updateEmailStatus = internalMutation({
  args: {
    communicationId: v.id("communications"),
    status: v.union(
      v.literal("sent"),
      v.literal("failed"),
      v.literal("delivered")
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.communicationId, {
      deliveryStatus: args.status,
      status: args.status === "failed" ? "failed" : "sent",
      errorMessage: args.error,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION: Record a matched inbound email reply in the communications table
// ─────────────────────────────────────────────────────────────────────────────
export const recordMatchedEmailReply = internalMutation({
  args: {
    applicationId: v.optional(v.id("applications")),
    candidateId: v.id("candidates"),
    jobId: v.optional(v.id("jobs")),
    taEmail: v.string(),
    subject: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const commId = await ctx.db.insert("communications", {
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      direction: "inbound",
      channel: "email",
      subject: args.subject,
      body: args.body,
      deliveryStatus: "read",
      sentAt: Date.now(),
      stoppedSequence: false,
    });

    // Trigger background extraction to parse salary / notice period / etc.
    await ctx.scheduler.runAfter(
      0,
      internal.communications.inboundExtraction.extractDetailsFromText,
      {
        candidateId: args.candidateId,
        textBody: args.body,
      }
    );

    return commId;
  },
});
