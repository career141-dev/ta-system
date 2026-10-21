import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { workdayDate } from "../../src/lib/workday";
import { EMAIL_RETENTION_MS, type DailyEmailSnapshot } from "../../src/lib/dailyEmail";
import { autoCompleteWorkday } from "../ta/workdays";

export async function middayRequired(ctx: QueryCtx | MutationCtx, date: string) {
  const policy = await ctx.db.query("dailyEmailPolicy").withIndex("by_key", q => q.eq("key", "midday")).first();
  return !!policy && date >= policy.requiredFrom;
}

/** One transaction records the accepted email and its exact candidate roster.
 * Recovery calls this same function; it never calls the mail provider again. */
export async function finalizeDailyEmail(ctx: MutationCtx, email: Doc<"dailyEmails">) {
  if (email.finalizedAt) return;
  if (email.status !== "accepted" || !email.snapshot) throw new Error("The email has not been accepted for sending.");
  const snapshot = email.snapshot as DailyEmailSnapshot;
  const at = email.acceptedAt ?? Date.now();
  let roundId = email.roundId;
  if (email.parentId) {
    const parent = await ctx.db.get(email.parentId);
    roundId = parent?.roundId;
    if (roundId) {
      const round = await ctx.db.get(roundId);
      if (round) await ctx.db.patch(roundId, { revisedAt: [...(round.revisedAt ?? []), at] });
    }
  } else if (email.applicationIds.length) {
    const apps = await Promise.all(email.applicationIds.map(id => ctx.db.get(id)));
    // SET numbers in the app are assigned independently of email numbering.
    const sets = apps.map(a => a?.setNumber).filter((n): n is number => typeof n === "number");
    roundId = await ctx.db.insert("reviewRounds", {
      openingId: email.jobId, kind: "director", submissionType: email.submissionType,
      workLocationId: email.workLocationId, workLocationName: email.workLocationName,
      token: `C141-MAIL-${email._id}`, applicationIds: email.applicationIds,
      sentBy: email.userId, sentAt: at, sentTo: snapshot.to[0],
      trackedAt: email.trackedAt, subject: snapshot.subject, researchLink: snapshot.researchLink,
      ...(sets.length ? { setNumber: Math.min(...sets) } : {}),
      dispatch: "sent", status: "awaiting", decisions: [],
    });
  }
  await ctx.db.patch(email._id, { finalizedAt: at, expiresAt: at + EMAIL_RETENTION_MS, ...(roundId ? { roundId } : {}) });
  for (const attachment of snapshot.attachments ?? []) {
    const file = await ctx.db.get(attachment.id as Id<"dailyEmailAttachments">);
    if (file) await ctx.db.patch(file._id, { expiresAt: Math.max(file.expiresAt, at + EMAIL_RETENTION_MS) });
  }
  if (email.receiptId) await ctx.db.patch(email.receiptId, { status: "accepted", acceptedAt: at, finalizedAt: at });
  if (email.receiptId && !email.parentId && email.submissionType === "eod") {
    const receipt = await ctx.db.get(email.receiptId);
    if (receipt) await autoCompleteWorkday(ctx, receipt.workdayId);
  }
}

export async function dailyEmailsFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">, jobId: Id<"jobs">, date = workdayDate(Date.now())) {
  return ctx.db.query("dailyEmails").withIndex("by_user_job_date", q => q.eq("userId", userId).eq("jobId", jobId).eq("date", date)).collect();
}
