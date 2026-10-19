/**
 * Reassign Sanduni's late Friday EOD, which was sent on Monday, back to the
 * Friday workday (creating the missing historical row if necessary) and
 * reopen Monday for continued work.
 *
 * The accepted email, attachments and candidate roster are never changed. Its
 * reporting date, review-round reporting time and workday receipt move; the
 * email's acceptedAt continues to record when Graph actually accepted it. Run
 * only through the release pipeline, first dryRun=true and then dryRun=false.
 *
 *   run_function: admin/repairSanduniMistimedEod:run
 *   run_args:     {"dryRun":true}
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const TA_EMAIL = "sanduni@career141.com";
const SENT_DATE = "2026-10-19";
const INTENDED_DATE = "2026-10-16";
const INTENDED_REPORT_AT = Date.parse(`${INTENDED_DATE}T23:59:59.999+05:30`);
const CLOSED_REQUEST_REASON = "Workday closed before approval";

const originalEod = (receipt: Doc<"taWorkdayMail">) =>
  receipt.status === "accepted" &&
  !!receipt.finalizedAt &&
  !receipt.revised &&
  (receipt.submissionType ?? "eod") === "eod";

export const run = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const users = (await ctx.db.query("users").collect()).filter(
      (user) => (user.email ?? "").trim().toLowerCase() === TA_EMAIL,
    );
    if (users.length !== 1)
      throw new Error(`Expected one active record for ${TA_EMAIL}; found ${users.length}. Nothing was changed.`);
    const user = users[0];
    if (!user.isActive)
      throw new Error(`${TA_EMAIL} is not active. Nothing was changed.`);

    const workdays = await ctx.db
      .query("taWorkdays")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const sourceDays = workdays.filter((day) => day.date === SENT_DATE);
    const targetDays = workdays.filter((day) => day.date === INTENDED_DATE);
    if (sourceDays.length !== 1 || targetDays.length > 1)
      throw new Error(
        `Expected one ${SENT_DATE} workday and at most one ${INTENDED_DATE} workday for ${TA_EMAIL}; found ${sourceDays.length} and ${targetDays.length}. Nothing was changed.`,
      );
    const source = sourceDays[0];
    let target = targetDays[0];
    if (source.closureReason !== "eod" || source.finishedAt === undefined)
      throw new Error(`${SENT_DATE} is not an EOD-completed workday. Nothing was changed.`);
    if (target && (target.finishedAt === undefined || !target.completion))
      throw new Error(`${INTENDED_DATE} has no closed workday snapshot to recover. Nothing was changed.`);

    // Resolve the opening from the accepted receipt, not its mutable title or
    // bin status. The failed 19 Oct dry run proved production's display row no
    // longer matched the original title guard, while this audit link remains.
    const sourceReceipts = await ctx.db
      .query("taWorkdayMail")
      .withIndex("by_workday_job", (q) => q.eq("workdayId", source._id))
      .collect();
    const acceptedSourceEods = sourceReceipts.filter(
      (receipt) => receipt.userId === user._id && originalEod(receipt) && !!receipt.dailyEmailId,
    );
    if (acceptedSourceEods.length !== 1)
      throw new Error(
        `Expected one accepted original EOD for ${TA_EMAIL} on ${SENT_DATE}; found ${acceptedSourceEods.length}. Nothing was changed.`,
      );
    const receipt = acceptedSourceEods[0];
    const job = await ctx.db.get(receipt.jobId);
    if (!job)
      throw new Error("The opening linked to Monday's accepted EOD no longer exists. Nothing was changed.");
    if (
      !source.jobs.some((entry) => entry.jobId === job._id) ||
      (target && !target.jobs.some((entry) => entry.jobId === job._id))
    )
      throw new Error("The EOD opening is not present on the available Friday and Monday workdays. Nothing was changed.");
    const email = await ctx.db.get(receipt.dailyEmailId!);
    if (
      !email ||
      email.userId !== user._id ||
      email.jobId !== job._id ||
      email.date !== SENT_DATE ||
      email.submissionType !== "eod" ||
      email.status !== "accepted" ||
      !email.finalizedAt ||
      email.parentId
    )
      throw new Error("The linked email is not the finalized original Monday EOD expected by this repair. Nothing was changed.");
    const round = email.roundId ? await ctx.db.get(email.roundId) : null;
    if (
      email.applicationIds.length > 0 &&
      (!round ||
        round.openingId !== job._id ||
        round.kind !== "director" ||
        round.sentBy !== user._id)
    )
      throw new Error("The email's Director-review round is missing or belongs to different records. Nothing was changed.");

    const targetReceipts = target
      ? await ctx.db
          .query("taWorkdayMail")
          .withIndex("by_workday_job", (q) =>
            q.eq("workdayId", target!._id).eq("jobId", job._id),
          )
          .collect()
      : [];
    if (targetReceipts.some(originalEod))
      throw new Error("Friday already has an accepted original EOD for this opening. Nothing was changed.");

    const sourceLeads = await ctx.db
      .query("taWorkdayLeads")
      .withIndex("by_workday", (q) => q.eq("workdayId", source._id))
      .collect();
    const targetLeads = target
      ? await ctx.db
          .query("taWorkdayLeads")
          .withIndex("by_workday", (q) => q.eq("workdayId", target!._id))
          .collect()
      : [];
    const closedRequests = (
      await ctx.db
        .query("taWorkdayRequests")
        .withIndex("by_workday", (q) => q.eq("workdayId", source._id))
        .collect()
    ).filter(
      (request) =>
        request.status === "denied" &&
        request.reason === CLOSED_REQUEST_REASON &&
        request.decidedAt === source.finishedAt,
    );

    const summary = {
      ta: { id: user._id as string, email: user.email },
      opening: { id: job._id as string, title: job.title },
      email: { id: email._id as string, acceptedAt: email.acceptedAt ?? null, fromDate: email.date, toDate: INTENDED_DATE },
      reviewRound: round ? { id: round._id as string, fromSentAt: round.sentAt, toSentAt: INTENDED_REPORT_AT } : null,
      receipt: { id: receipt._id as string, fromWorkdayId: source._id as string, toWorkdayId: target ? (target._id as string) : null },
      monday: { id: source._id as string, finishedAt: source.finishedAt, leadRows: sourceLeads.length, requestsToRestore: closedRequests.length },
      friday: target
        ? { plannedCreate: false, id: target._id as string, finishedAt: target.finishedAt, priorClosureReason: target.closureReason ?? null, leadRows: targetLeads.length }
        : { plannedCreate: true, id: null, finishedAt: INTENDED_REPORT_AT, priorClosureReason: null, leadRows: 0 },
    };
    if (args.dryRun)
      return { dryRun: true, changed: false, summary, next: 'Run again with {"dryRun":false} after reviewing these exact records.' };

    if (!target) {
      const sourceEntry = source.jobs.find((entry) => entry.jobId === job._id)!;
      const workType = receipt.workType ?? sourceEntry.workType;
      const targetId = await ctx.db.insert("taWorkdays", {
        userId: user._id,
        date: INTENDED_DATE,
        startedAt: INTENDED_REPORT_AT,
        finishedAt: INTENDED_REPORT_AT,
        closureReason: "eod",
        jobs: [{
          jobId: job._id,
          workType,
          addedAt: INTENDED_REPORT_AT,
          leadId: sourceEntry.leadId,
          modeHistory: [{ at: INTENDED_REPORT_AT, workType }],
        }],
      });
      await ctx.db.patch(targetId, {
        completion: {
          id: targetId,
          userId: user._id,
          name: user.fullName,
          date: INTENDED_DATE,
          startedAt: INTENDED_REPORT_AT,
          finishedAt: INTENDED_REPORT_AT,
          closureReason: "eod",
          jobs: [{
            jobId: job._id,
            title: job.title,
            workType,
            eodSentAt: receipt.acceptedAt ?? receipt.finalizedAt,
            checks: [],
            eodChecks: [],
            shortlist: [],
            activity: {
              cvReviews: 0,
              profilesAdded: 0,
              profilesWorked: 0,
              researchAt: null,
              researchActions: 0,
              benchmarkActions: 0,
              benchmarks: 0,
              benchmarksAdded: 0,
              sent: receipt.applicationIds.length,
              emailAt: receipt.acceptedAt ?? receipt.finalizedAt ?? null,
              jdApproved: job.jdStatus === "approved",
              postConnected: false,
            },
          }],
          requests: [],
        },
      });
      if (sourceEntry.leadId)
        await ctx.db.insert("taWorkdayLeads", {
          workdayId: targetId,
          leadId: sourceEntry.leadId,
          finishedAt: INTENDED_REPORT_AT,
        });
      target = (await ctx.db.get(targetId))!;
    }

    await ctx.db.patch(email._id, { date: INTENDED_DATE });
    await ctx.db.patch(receipt._id, { workdayId: target._id });
    if (round) await ctx.db.patch(round._id, { sentAt: INTENDED_REPORT_AT });

    const targetCompletion = target.completion as Record<string, unknown>;
    await ctx.db.patch(target._id, {
      closureReason: "eod",
      completion: { ...targetCompletion, closureReason: "eod" },
    });
    const finalTargetLeads = await ctx.db
      .query("taWorkdayLeads")
      .withIndex("by_workday", (q) => q.eq("workdayId", target._id))
      .collect();
    for (const lead of finalTargetLeads)
      await ctx.db.patch(lead._id, { finishedAt: target.finishedAt });

    await ctx.db.patch(source._id, {
      finishedAt: undefined,
      closureReason: undefined,
      completion: undefined,
    });
    for (const lead of sourceLeads)
      await ctx.db.patch(lead._id, { finishedAt: undefined });
    for (const request of closedRequests)
      await ctx.db.patch(request._id, {
        status: "pending",
        decidedAt: undefined,
        decidedBy: undefined,
        reason: undefined,
      });

    return { dryRun: false, changed: true, summary };
  },
});
