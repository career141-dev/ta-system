/**
 * Put a candidate back to the start of the follow-up conversation.
 *
 * Why this exists: testing the chase end to end means running it more than
 * once, and `resetFollowUpApp` only moves the stage — it leaves
 * `followUpCvReceived`, the salaries and the notice period exactly where they
 * were, so the second run opens with the checklist already full and the
 * assistant with nothing to ask. The alternative was hand-editing rows in the
 * data browser, which is how a real candidate's record gets cleared by
 * accident (23 September).
 *
 * `dryRun` defaults to TRUE. Called with nothing else, it reports what it
 * would clear and changes not one field — so seeing the plan costs nothing and
 * the destructive call has to be typed deliberately. It names the candidate
 * and the opening in that report, which is the moment to notice you are
 * pointed at the wrong person.
 *
 * This is a testing tool. It throws away real answers a real candidate gave,
 * and there is no undo.
 */
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

export const resetFollowUpTest = internalMutation({
  args: {
    applicationId: v.id("applications"),
    /** FALSE actually clears the data. Omit it to see the plan first. */
    dryRun: v.optional(v.boolean()),
    /**
     * Also delete this application's WhatsApp and email messages, so the
     * conversation starts empty. Off by default: the transcript is usually the
     * thing you want to read after a test, not lose.
     */
    clearConversation: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error(`Application ${args.applicationId} does not exist.`);

    const candidate = await ctx.db.get(app.candidateId);
    const job = await ctx.db.get(app.jobId);

    // What is actually set right now — so the report is the truth, not a list
    // of field names.
    const wouldClear: string[] = [];
    if (app.followUpCvReceived) wouldClear.push("CV marked received");
    if (app.followUpCurrentSalary) wouldClear.push("current salary collected");
    if (app.followUpExpectedSalary) wouldClear.push("expected salary collected");
    if (app.followUpNoticePeriod) wouldClear.push("notice period collected");
    if (Object.keys(app.customFollowUpAnswers ?? {}).length) wouldClear.push("custom question answers");
    if (typeof candidate?.currentSalary === "number") wouldClear.push(`candidate.currentSalary = ${candidate.currentSalary}`);
    if (typeof candidate?.expectedSalary === "number") wouldClear.push(`candidate.expectedSalary = ${candidate.expectedSalary}`);
    if (candidate?.currentSalaryNote) wouldClear.push(`candidate.currentSalaryNote = "${candidate.currentSalaryNote}"`);
    if (candidate?.expectedSalaryNote) wouldClear.push(`candidate.expectedSalaryNote = "${candidate.expectedSalaryNote}"`);
    if (typeof candidate?.noticePeriodDays === "number") wouldClear.push(`candidate.noticePeriodDays = ${candidate.noticePeriodDays}`);
    if (candidate?.noticePeriod) wouldClear.push(`candidate.noticePeriod = "${candidate.noticePeriod}"`);

    const messages = await ctx.db
      .query("communications")
      .withIndex("by_applicationId", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    const plan = {
      candidate: candidate?.fullName ?? String(app.candidateId),
      candidatePhone: candidate?.phone ?? null,
      opening: job?.title ?? String(app.jobId),
      stage: `${app.currentStage} -> follow_up`,
      attempts: `${app.followUpAttemptCount ?? 0} -> 0`,
      wouldClear: wouldClear.length ? wouldClear : ["nothing is set — already at the start"],
      messages: args.clearConversation === true
        ? `${messages.length} message(s) WOULD BE DELETED`
        : `${messages.length} message(s) kept (pass clearConversation: true to delete)`,
    };

    if (dryRun) {
      return { dryRun: true as const, ...plan, note: "Nothing changed. Re-run with dryRun: false to apply." };
    }

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      currentStage: "follow_up",
      followUpEnteredAt: now,
      lastStageChangedAt: now,
      followUpAttemptCount: 0,
      followUpCvReceived: undefined,
      followUpCurrentSalary: undefined,
      followUpExpectedSalary: undefined,
      followUpNoticePeriod: undefined,
      customFollowUpAnswers: undefined,
      candidateCurrentSalary: undefined,
      candidateExpectedSalary: undefined,
      candidateNoticePeriodDays: undefined,
      nextFollowUpScheduledAt: undefined,
      nextFollowUpMessage: undefined,
      waitingForCandidateEta: undefined,
      candidateEtaMs: undefined,
      candidateEtaText: undefined,
      flaggedForTaReview: false,
      taReviewReason: undefined,
      lastCandidateReplyAt: undefined,
      stageHistory: [
        ...(app.stageHistory ?? []),
        {
          stage: "follow_up",
          enteredAt: new Date().toISOString(),
          changedBy: "system" as any,
          note: "Reset by admin/resetFollowUpTest for a repeat end-to-end test.",
        },
      ],
    });

    if (candidate) {
      await ctx.db.patch(app.candidateId, {
        currentSalary: undefined,
        expectedSalary: undefined,
        currentSalaryNote: undefined,
        expectedSalaryNote: undefined,
        noticePeriodDays: undefined,
        noticePeriod: undefined,
      });
    }

    let deleted = 0;
    if (args.clearConversation === true) {
      for (const m of messages) {
        await ctx.db.delete(m._id);
        deleted++;
      }
    }

    console.log(
      `[Reset Follow-Up Test] ${plan.candidate} on "${plan.opening}" reset to follow_up; ` +
        `${wouldClear.length} field group(s) cleared, ${deleted} message(s) deleted.`,
    );
    return { dryRun: false as const, ...plan, messagesDeleted: deleted, done: true as const };
  },
});
