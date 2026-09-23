/**
 * How much the follow-up sweep would send if outreach were switched back on.
 *
 * Why this exists: outreach has been off on production since 21 September, so
 * applications have been accumulating overdue `nextFollowUpScheduledAt`
 * timestamps. The moment a test recipient is configured, the seven-minute
 * sweep (`convex/crons.ts`) starts firing every one of them — 60 per run until
 * the backlog drains — and `resolveRecipient` redirects all of them to that one
 * number. Each is a WhatsApp template outside the 24-hour window, so each is
 * billed.
 *
 * Counting first turns "set the test phone and see what happens" into a number
 * you can look at. Read-only: it writes nothing and sends nothing.
 *
 * Run it from the Convex dashboard's function runner before setting
 * `OUTREACH_TEST_PHONE` on a deployment that holds real candidates.
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { followUpOn } from "../lib/followUpScope";

/** Matches the sweep's own cap, so "would fire now" means one sweep run. */
const SWEEP_MAX_PER_RUN = 60;

/** Stops a wide scan on a large table from timing out the query. */
const SCAN_CAP_PER_JOB_STAGE = 500;

export const countDueFollowUps = internalQuery({
  args: {
    /** Only openings the TA System switched on (`followUpStartsOnSend`). */
    taOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const jobs = await ctx.db.query("jobs").collect();
    const activeJobs = jobs.filter((j: any) => j.status === "active");
    const followUpJobs = activeJobs.filter(
      (j: any) => followUpOn(j) && (args.taOnly !== true || j.followUpStartsOnSend === true),
    );

    let overdue = 0;
    let scheduledLater = 0;
    let noSchedule = 0;
    let blockedByMaxAttempts = 0;
    let waitingOnCandidateEta = 0;
    let scanCapHit = false;
    const perJob: Array<{ job: string; overdue: number }> = [];

    for (const job of followUpJobs) {
      let jobOverdue = 0;
      for (const stage of ["follow_up", "ta_shortlist"] as const) {
        const apps = await ctx.db
          .query("applications")
          .withIndex("by_job_stage", (i: any) => i.eq("jobId", job._id).eq("currentStage", stage))
          .take(SCAN_CAP_PER_JOB_STAGE);
        if (apps.length === SCAN_CAP_PER_JOB_STAGE) scanCapHit = true;

        for (const app of apps) {
          const maxAttempts = (job as any).maxFollowUpAttempts ?? 3;
          if ((app.followUpAttemptCount ?? 0) >= maxAttempts) {
            blockedByMaxAttempts++;
            continue;
          }
          if (!app.nextFollowUpScheduledAt) {
            noSchedule++;
            continue;
          }
          if (now < app.nextFollowUpScheduledAt) {
            scheduledLater++;
            continue;
          }
          if (app.waitingForCandidateEta === true) waitingOnCandidateEta++;
          jobOverdue++;
          overdue++;
        }
      }
      if (jobOverdue > 0) perJob.push({ job: job.title ?? String(job._id), overdue: jobOverdue });
    }

    perJob.sort((a, b) => b.overdue - a.overdue);

    return {
      // The headline: how many messages would go out, and how long that takes.
      overdue,
      wouldFireOnFirstSweep: Math.min(overdue, SWEEP_MAX_PER_RUN),
      sweepRunsToDrain: Math.ceil(overdue / SWEEP_MAX_PER_RUN),
      minutesToDrain: Math.ceil(overdue / SWEEP_MAX_PER_RUN) * 7,

      // Context for the number above.
      openingsWithFollowUpOn: followUpJobs.length,
      activeOpenings: activeJobs.length,
      scheduledLater,
      noSchedule,
      blockedByMaxAttempts,
      waitingOnCandidateEta,
      perJob: perJob.slice(0, 20),

      // True when an opening had more than SCAN_CAP_PER_JOB_STAGE applications
      // in one stage: `overdue` is then a floor, not the whole picture.
      scanCapHit,
    };
  },
});
