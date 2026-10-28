/**
 * Reopen Sameera's early 28 Oct EOD on Q Collection's Industrial Engineering
 * opening. The accepted mail stays in history; this restores her own workday
 * and candidate roster for the normal Midday then EOD flow.
 * Run only through the release pipeline, dryRun=true first.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { workdayDate } from "../../src/lib/workday";

const JOB_ID = "m17cw4va2wvhvc80bm9md3mbj98gc3c0";
const DATE = "2026-10-28";

export const run = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }) => {
    if (workdayDate(Date.now()) !== DATE) throw new Error("This same-day recovery is no longer valid.");
    const jobId = ctx.db.normalizeId("jobs", JOB_ID);
    const job = jobId && await ctx.db.get(jobId);
    if (!job || !/industrial engineering/i.test(job.title))
      throw new Error("The named opening does not match production.");
    const emails = await ctx.db.query("dailyEmails").withIndex("by_job", q => q.eq("jobId", job._id)).collect();
    const todaysEmails = emails.filter(e => e.date === DATE);
    const senders = await Promise.all([...new Set(todaysEmails.map(e => e.userId))].map(id => ctx.db.get(id)));
    const users = senders.filter(u => u && u.isActive && /\b(sameera|samira)\b/i.test(u.fullName));
    if (users.length !== 1) throw new Error("Expected exactly one active Sameera on this opening's emails today.");
    const user = users[0]!;
    const own = todaysEmails.filter(e => e.userId === user._id);
    const originals = own.filter(e => e.submissionType === "eod" && !e.parentId && e.status === "accepted" && e.finalizedAt && !e.recoveryReopenedAt);
    if (originals.length !== 1 || own.some(e => e.parentId || e.status === "sending" || e.status === "uncertain"))
      throw new Error("Expected one finalized original EOD and no revisions or unresolved sends.");
    const email = originals[0];
    if (!email.acceptedAt || workdayDate(email.acceptedAt) !== DATE)
      throw new Error("The accepted EOD was not sent on the named date.");
    const days = (await ctx.db.query("taWorkdays").withIndex("by_user", q => q.eq("userId", user._id)).collect()).filter(d => d.date === DATE);
    if (days.length !== 1 || !days[0].jobs.some(entry => entry.jobId === job._id))
      throw new Error("Expected exactly one workday containing this opening today.");
    const day = days[0];
    if (day.finishedAt !== undefined && (day.closureReason !== "eod" || !day.completion))
      throw new Error("The closed workday was not completed by EOD.");
    const receipts = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", job._id)).collect();
    const receipt = receipts.find(r => r._id === email.receiptId);
    if (!receipt || receipt.dailyEmailId !== email._id || receipt.userId !== user._id || receipt.status !== "accepted" || !receipt.finalizedAt || receipt.recoveryReopenedAt)
      throw new Error("The accepted workday receipt does not match the email.");
    if (receipts.some(r => r._id !== receipt._id && r.userId === user._id && (r.submissionType ?? "eod") === "eod" && r.status === "accepted"))
      throw new Error("Another EOD has been accepted for this opening today.");
    const round = email.roundId ? await ctx.db.get(email.roundId) : null;
    if (email.applicationIds.length && (!round || round.openingId !== job._id || round.sentBy !== user._id || round.kind !== "director" || round.status !== "awaiting" || round.decisions.length || round.recoveryReopenedAt))
      throw new Error("The Director review round has changed or received a decision.");
    const candidates = await Promise.all(email.applicationIds.map(id => ctx.db.get(id)));
    if (candidates.some(a => !a || a.jobId !== job._id || a.ownerTaId !== user._id || a.currentStage !== "second_shortlist"))
      throw new Error("A candidate has changed owner or stage since the early email.");
    const leads = day.finishedAt === undefined ? [] : await ctx.db.query("taWorkdayLeads").withIndex("by_workday", q => q.eq("workdayId", day._id)).collect();
    const requests = day.finishedAt === undefined ? [] : (await ctx.db.query("taWorkdayRequests").withIndex("by_workday", q => q.eq("workdayId", day._id)).collect())
      .filter(r => r.status === "denied" && r.reason === "Workday closed before approval" && r.decidedAt === day.finishedAt);
    const summary = { userId: user._id, userName: user.fullName, jobId: job._id, jobTitle: job.title, workdayId: day._id,
      workdayClosed: day.finishedAt !== undefined, emailId: email._id, receiptId: receipt._id, roundId: round?._id ?? null,
      candidateIds: email.applicationIds, acceptedAt: email.acceptedAt, leadsToReopen: leads.length,
      requestsToRestore: requests.length, otherTaEmailsOnOpening: todaysEmails.filter(e => e.userId !== user._id).map(e => ({ id: e._id, userId: e.userId, status: e.status })) };
    if (dryRun) return { dryRun: true, changed: false, summary };
    const at = Date.now();
    await ctx.db.patch(email._id, { recoveryReopenedAt: at });
    await ctx.db.patch(receipt._id, { recoveryReopenedAt: at });
    if (round) await ctx.db.patch(round._id, { recoveryReopenedAt: at });
    if (day.finishedAt !== undefined) {
      await ctx.db.patch(day._id, { finishedAt: undefined, closureReason: undefined, completion: undefined });
      for (const lead of leads) await ctx.db.patch(lead._id, { finishedAt: undefined });
      for (const request of requests) await ctx.db.patch(request._id, { status: "pending", decidedAt: undefined, decidedBy: undefined, reason: undefined });
    }
    return { dryRun: false, changed: true, summary };
  },
});
