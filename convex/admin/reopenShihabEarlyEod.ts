/**
 * Recover the 20 Oct early EOD for Shihab on RSL Shipping. The accepted email
 * remains in history with its real send time. Its roster no longer consumes
 * today's Director Review candidates, and a new midday and EOD can be sent.
 * Run only through the production release pipeline, dryRun=true first.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { workdayDate } from "../../src/lib/workday";

const EMAIL = "shihab@career141.com";
const JOB_ID = "m17bhyypymgftktd7cv3w7sjfh8gkyst";
const DATE = "2026-10-20";

export const run = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }) => {
    if (workdayDate(Date.now()) !== DATE) throw new Error("This same-day recovery is no longer valid.");
    const users = (await ctx.db.query("users").collect()).filter(u => u.email?.trim().toLowerCase() === EMAIL && u.isActive);
    if (users.length !== 1) throw new Error("Expected exactly one active Shihab account.");
    const user = users[0];
    const jobId = ctx.db.normalizeId("jobs", JOB_ID);
    const job = jobId && await ctx.db.get(jobId);
    if (!job || job.title !== "Senior Operations Executive") throw new Error("The named opening does not match production.");
    const days = (await ctx.db.query("taWorkdays").withIndex("by_user", q => q.eq("userId", user._id)).collect()).filter(d => d.date === DATE);
    if (days.length !== 1) throw new Error("Expected exactly one workday today.");
    const day = days[0];
    if (day.finishedAt === undefined || day.closureReason !== "eod" || !day.completion || !day.jobs.some(entry => entry.jobId === job._id))
      throw new Error("Today's closed workday does not contain the expected EOD opening.");
    const allReceipts = (await Promise.all(day.jobs.map(entry => ctx.db.query("taWorkdayMail")
      .withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", entry.jobId)).collect()))).flat();
    // A TA can finish several openings in one workday. Their other accepted
    // EODs remain final; only this opening's mistaken send is reopened.
    const otherAcceptedEods = allReceipts.filter(r => r.jobId !== job._id && r.status === "accepted" && r.finalizedAt && !r.revised && (r.submissionType ?? "eod") === "eod");
    const emails = await ctx.db.query("dailyEmails").withIndex("by_user_job_date", q => q.eq("userId", user._id).eq("jobId", job._id).eq("date", DATE)).collect();
    const originals = emails.filter(e => e.submissionType === "eod" && !e.parentId && e.status === "accepted" && e.finalizedAt && !e.recoveryReopenedAt);
    if (originals.length !== 1 || emails.some(e => e.parentId || e.status === "sending" || e.status === "uncertain"))
      throw new Error("Expected one finalized original EOD and no revisions or unresolved sends.");
    const email = originals[0];
    const receipts = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", job._id)).collect();
    const receipt = receipts.find(r => r._id === email.receiptId);
    if (!receipt || receipt.dailyEmailId !== email._id || receipt.userId !== user._id || receipt.status !== "accepted" || !receipt.finalizedAt || receipt.recoveryReopenedAt)
      throw new Error("The accepted workday receipt does not match the email.");
    if (receipts.some(r => r._id !== receipt._id && (r.submissionType ?? "eod") === "eod" && r.status === "accepted"))
      throw new Error("Another EOD has been accepted on this workday.");
    const round = email.roundId ? await ctx.db.get(email.roundId) : null;
    if (email.applicationIds.length && (!round || round.openingId !== job._id || round.sentBy !== user._id || round.kind !== "director" || round.status !== "awaiting" || round.decisions.length || round.recoveryReopenedAt))
      throw new Error("The Director review round has changed or received a decision.");
    const candidates = await Promise.all(email.applicationIds.map(id => ctx.db.get(id)));
    if (candidates.some(a => !a || a.jobId !== job._id || a.ownerTaId !== user._id || a.currentStage !== "second_shortlist"))
      throw new Error("A candidate has changed owner or stage since the early email.");
    const leads = await ctx.db.query("taWorkdayLeads").withIndex("by_workday", q => q.eq("workdayId", day._id)).collect();
    const requests = (await ctx.db.query("taWorkdayRequests").withIndex("by_workday", q => q.eq("workdayId", day._id)).collect())
      .filter(r => r.status === "denied" && r.reason === "Workday closed before approval" && r.decidedAt === day.finishedAt);
    const summary = { userId: user._id, jobId: job._id, workdayId: day._id, emailId: email._id,
      receiptId: receipt._id, roundId: round?._id ?? null, candidateIds: email.applicationIds,
      leadsToReopen: leads.length, requestsToRestore: requests.length, acceptedAt: email.acceptedAt ?? null,
      otherAcceptedEods: otherAcceptedEods.map(r => ({ receiptId: r._id, jobId: r.jobId, acceptedAt: r.acceptedAt ?? null })) };
    if (dryRun) return { dryRun: true, changed: false, summary };
    const at = Date.now();
    await ctx.db.patch(email._id, { recoveryReopenedAt: at });
    await ctx.db.patch(receipt._id, { recoveryReopenedAt: at });
    if (round) await ctx.db.patch(round._id, { recoveryReopenedAt: at });
    await ctx.db.patch(day._id, { finishedAt: undefined, closureReason: undefined, completion: undefined });
    for (const lead of leads) await ctx.db.patch(lead._id, { finishedAt: undefined });
    for (const request of requests) await ctx.db.patch(request._id, { status: "pending", decidedAt: undefined, decidedBy: undefined, reason: undefined });
    return { dryRun: false, changed: true, summary };
  },
});
