/**
 * How many candidates the follow-up actually reaches, and what that costs.
 *
 * Every number in the cost discussion was an assumption (2 October): $500 a
 * month for WhatsApp, from "10,000 candidates × 2 templates × $0.025". The
 * rate was the Marketing one, the 2 templates ignored that a candidate who
 * replies only costs the first, and the 10,000 was the entire database rather
 * than the people a TA shortlists. This reads the real figures instead.
 *
 * The driver is NOT how many candidates exist. 78,000 rows in `candidates`
 * cost nothing. The follow-up only sends for an application in Follow-up on an
 * opening that has auto follow-up switched on — so throughput through that
 * stage is the whole story.
 *
 * Read-only: writes nothing, sends nothing, safe to run on production whenever.
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { followUpOn } from "../lib/followUpScope";
import {
  DAILY_CONVERSATION_LIMIT,
  META_UTILITY_RATE_USD,
  forecastTemplates,
  monthlyCeiling,
} from "../lib/templateForecast";

/** Caps the scan so a wide read cannot time the query out on a large table. */
const SCAN_CAP = 4000;

export const outreachVolume = internalQuery({
  args: {
    /** How far back to measure real throughput. 30 days unless given. */
    days: v.optional(v.number()),
    /** Fraction who answer the first message. They cost one template, not three. */
    replyRate: v.optional(v.number()),
    /** TA numbers wired up. Meta's 250/day limit is per number. */
    numbers: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const days = Math.max(1, Math.floor(args.days ?? 30));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    // Which openings the follow-up can run on at all. An opening with the
    // switch off never sends, however many candidates sit on it.
    const jobs = await ctx.db.query("jobs").collect();
    const activeJobs = jobs.filter((j: any) => j.status === "active");
    const liveJobIds = new Set(activeJobs.filter((j: any) => followUpOn(j)).map((j) => j._id));

    let scanCapHit = false;
    const inStage: Record<string, number> = { follow_up: 0, ta_shortlist: 0 };
    let onLiveOpenings = 0;
    let withPhone = 0;
    let withEmail = 0;
    let withNeither = 0;
    let enteredInWindow = 0;
    let attemptsUsed = 0;

    for (const stage of ["follow_up", "ta_shortlist"] as const) {
      const apps = await ctx.db
        .query("applications")
        .withIndex("by_stage", (q) => q.eq("currentStage", stage))
        .take(SCAN_CAP);
      if (apps.length === SCAN_CAP) scanCapHit = true;
      inStage[stage] = apps.length;

      for (const app of apps) {
        if (!liveJobIds.has(app.jobId)) continue;
        onLiveOpenings++;
        attemptsUsed += app.followUpAttemptCount ?? 0;
        if (app.followUpEnteredAt && app.followUpEnteredAt >= since) enteredInWindow++;

        const candidate = await ctx.db.get(app.candidateId);
        const phone = !!(candidate?.phone ?? "").replace(/\D/g, "");
        const email = !!candidate?.email;
        if (phone) withPhone++;
        if (email) withEmail++;
        if (!phone && !email) withNeither++;
      }
    }

    // Measured throughput, projected to a month. Only candidates with a phone
    // can cost a WhatsApp template at all.
    const perMonth = days === 30 ? enteredInWindow : Math.round((enteredInWindow / days) * 30);
    const phoneShare = onLiveOpenings > 0 ? withPhone / onLiveOpenings : 0;
    const reachablePerMonth = Math.round(perMonth * phoneShare);

    const maxAttempts = Math.round(
      activeJobs.length > 0
        ? activeJobs.reduce((sum: number, j: any) => sum + (j.maxFollowUpAttempts ?? 3), 0) / activeJobs.length
        : 3,
    );

    const measured = forecastTemplates({
      candidates: reachablePerMonth,
      maxAttempts,
      replyRate: args.replyRate,
      numbers: args.numbers,
    });

    // The same arithmetic at the volumes that have been discussed, so the real
    // figure can be read against them.
    const scenarios = [1000, 5000, 10000].map((candidates) => ({
      candidates,
      ...forecastTemplates({ candidates, maxAttempts, replyRate: args.replyRate, numbers: args.numbers }),
    }));

    return {
      measuredOver: `${days} days`,

      // What the follow-up can run on at all.
      openings: {
        active: activeJobs.length,
        withAutoFollowUpOn: liveJobIds.size,
        note:
          liveJobIds.size === 0
            ? "No opening has auto follow-up on, so the sweep sends nothing today."
            : `${liveJobIds.size} of ${activeJobs.length} active openings can send.`,
      },

      // Who is in the stage right now.
      inFollowUpNow: {
        follow_up: inStage.follow_up,
        ta_shortlist: inStage.ta_shortlist,
        onOpeningsThatCanSend: onLiveOpenings,
        withPhone,
        withEmail,
        withNeither,
        attemptsAlreadyUsed: attemptsUsed,
      },

      // Measured throughput, which is the number that actually matters.
      throughput: {
        enteredFollowUpInWindow: enteredInWindow,
        perMonth,
        reachableByWhatsAppPerMonth: reachablePerMonth,
        averageMaxAttempts: maxAttempts,
      },

      // The answer.
      forecast: {
        ...measured,
        rateUsed: META_UTILITY_RATE_USD,
        rateNote: "Meta USD rate card, Rest of Asia Pacific, Utility, effective 1 October 2026.",
      },

      // Meta's limit, which binds before the budget does.
      ceiling: {
        dailyPerNumber: DAILY_CONVERSATION_LIMIT,
        ...monthlyCeiling(args.numbers ?? 1),
        note: "No budget sends more than this. Each extra TA number raises it by 250/day.",
      },

      scenarios,

      // True when an opening had more than SCAN_CAP applications in one stage:
      // the counts are then a floor, not the whole picture.
      scanCapHit,
    };
  },
});
