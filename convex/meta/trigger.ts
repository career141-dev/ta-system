import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

export const triggerMetaEventIfEligible = internalMutation({
  args: {
    applicationId: v.id("applications"),
    eventName: v.string(), // "Lead", "QualifiedLead", "Schedule", "Hire"
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;

    // Only trigger for whatsapp applicants (Meta CTWA)
    if (app.sourceChannel !== "whatsapp") {
      return;
    }

    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) return;

    // Check Idempotency
    const sentEvents = app.metaConversionSentFor || [];
    if (sentEvents.includes(args.eventName)) {
      console.log(`[MetaTrigger] Event ${args.eventName} already sent for App ${app._id}. Skipping.`);
      return;
    }

    // Mark as sent
    await ctx.db.patch(app._id, {
      metaConversionSentFor: [...sentEvents, args.eventName]
    });

    const job = await ctx.db.get(app.jobId);
    const eventId = `app_${app._id}_${args.eventName}`;

    // Split name for Meta
    const nameParts = (candidate.fullName || app.candidateName || "").split(" ");
    const firstName = nameParts[0] || undefined;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;

    // Dispatch Action
    await ctx.scheduler.runAfter(0, internal.meta.conversions.sendConversionEvent, {
      eventName: args.eventName,
      eventId,
      email: candidate.email || app.candidateEmail,
      phone: candidate.phone || app.candidatePhone,
      firstName,
      lastName,
      jobTitle: job?.title,
    });
  }
});
