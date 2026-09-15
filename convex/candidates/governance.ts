import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireFullAccess, requireUser } from "../lib/permissions";

/**
 * Anonymize or Delete Candidate Data for Privacy & Governance Compliance (GDPR)
 */
export const anonymizeCandidate = mutation({
  args: {
    candidateId: v.id("candidates"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireFullAccess(ctx);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");

    const now = Date.now();
    await ctx.db.patch(args.candidateId, {
      fullName: `Anonymized Candidate (${args.candidateId.slice(-4)})`,
      email: `anonymized_${args.candidateId}@deleted.local`,
      phone: `+0000000${Date.now().toString().slice(-6)}`,
      linkedinUrl: undefined,
      doNotContact: true,
      doNotContactReason: args.reason || "GDPR / Privacy Data Erasure Request",
      summary: "Profile anonymized per privacy request.",
    });

    return { success: true, candidateId: args.candidateId };
  },
});

export const setCommunicationSuppression = mutation({
  args: {
    candidateId: v.id("candidates"),
    doNotContact: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");

    await ctx.db.patch(args.candidateId, {
      doNotContact: args.doNotContact,
      doNotContactReason: args.reason,
    });

    return { success: true };
  },
});

export const checkSuppressionStatus = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) return { suppressed: false };
    return {
      suppressed: candidate.doNotContact === true,
      reason: candidate.doNotContactReason,
    };
  },
});
