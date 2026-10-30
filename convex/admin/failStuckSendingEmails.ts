/**
 * The flag-stuck cron may already have moved them to uncertain; both states are accepted.
 * Two EOD emails stayed in "sending" for days (Priya 23 Oct, Sameera 29 Oct) and blocked their own
 * senders on those openings. The owner confirmed on 30 Oct that neither reached the Director, so each
 * is recorded as failed and its receipt too; the candidates return to the senders' rosters. Nothing is
 * sent. Run only through the release pipeline, dryRun=true first.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { refreshWorkdayChecks } from "../ta/workdays";

const STUCK = [
  { emailId: "p17gts5z1e37zd0y37vp8kdyd98h6qkc", userId: "n179ssr2bhb24gc6anv64zb7rx8e68f0", jobId: "m178exn6qt75zhvej59a6pc5fh8gda38" },
  { emailId: "p17pj53s53wfa14ma6gg66nvd98gtd70", userId: "n176kws1qdtv08yyzyp06ph40d8fskr5", jobId: "m17cw4va2wvhvc80bm9md3mbj98gc3c0" },
];
const REASON = "Verified not sent: the owner confirmed on 30 Oct 2026 that this email never reached the Director desk; it was stuck in sending.";

export const run = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }) => {
    const found = [];
    for (const target of STUCK) {
      const id = ctx.db.normalizeId("dailyEmails", target.emailId);
      const email = id && await ctx.db.get(id);
      if (!email || email.userId !== target.userId || email.jobId !== target.jobId)
        throw new Error("A named email does not match production.");
      if ((email.status !== "sending" && email.status !== "uncertain") || email.finalizedAt || email.roundId)
        throw new Error("A named email is no longer stuck in sending or uncertain.");
      const receipt = email.receiptId ? await ctx.db.get(email.receiptId) : null;
      if (receipt && (receipt.dailyEmailId !== email._id || (receipt.status !== "sending" && receipt.status !== "uncertain")))
        throw new Error("A named receipt does not match its email.");
      found.push({ email, receipt });
    }
    const summary = found.map(({ email, receipt }) => ({ emailId: email._id, userId: email.userId, jobId: email.jobId, date: email.date,
      candidates: email.applicationIds.length, receiptId: receipt?._id ?? null }));
    if (dryRun) return { dryRun: true, changed: false, summary };
    for (const { email, receipt } of found) {
      await ctx.db.patch(email._id, { status: "failed", reconciliationReason: REASON });
      if (receipt) await ctx.db.patch(receipt._id, { status: "failed", reconciledAt: Date.now(), reconciliationReason: REASON });
      await refreshWorkdayChecks(ctx, email.jobId, email.userId);
    }
    return { dryRun: false, changed: true, summary };
  },
});
