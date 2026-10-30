// convex/ta/eodCopies.ts
//
// A sent end-of-day email is kept for a month so the TA can read it back, and
// correct it and send it again when the TA Lead or a Director asks (8 Oct —
// first a day, then the desk asked for a month of history). Once the month is
// over that version's content is deleted here. Each new accepted revision has
// its own 31 days. The review round and lineage stay after content expiry.
//
// The app hides a copy the moment its month is over (src/data/store.ts
// eodCopies), so this only has to catch up, not be on time.

import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { EMAIL_RETENTION_MS, type DailyEmailSnapshot } from "../../src/lib/dailyEmail";
import { eodEmailHtml } from "../../src/lib/eod-format";
import { workdayDate } from "../../src/lib/workday";
import { refreshWorkdayChecks } from "./workdays";

const BATCH = 200;
// A send whose result never came back (the action died) sat in "sending" for days and blocked its
// sender on that opening with no one told (Sameera 29 Oct, Priya 23 Oct). Past this it is "uncertain":
// the TA Lead sees it in Today's Checks and reconciles it. Never retried or resent from here.
// Longer than the send action can run (Convex actions stop at 10 minutes), so a live send is never flagged.
const STUCK_SENDING_MS = 15 * 60000;

/** Flag sends that never got a result, in their own small transaction so the purge is unaffected. */
export const flagStuckSends = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stuck = await ctx.db.query("dailyEmails").withIndex("by_status", q => q.eq("status", "sending").lt("startedAt", Date.now() - STUCK_SENDING_MS)).take(25);
    for (const email of stuck) {
      await ctx.db.patch(email._id, { status: "uncertain" });
      if (email.receiptId) await ctx.db.patch(email.receiptId, { status: "uncertain" });
      await refreshWorkdayChecks(ctx, email.jobId, email.userId);
    }
    // Receipts of the older send path have no daily email to flip them.
    const legacy = await ctx.db.query("taWorkdayMail").withIndex("by_status", q => q.eq("status", "sending").lt("startedAt", Date.now() - STUCK_SENDING_MS)).take(25);
    for (const receipt of legacy.filter(r => !r.dailyEmailId)) {
      await ctx.db.patch(receipt._id, { status: "uncertain" });
      await refreshWorkdayChecks(ctx, receipt.jobId, receipt.userId);
    }
    return { flagged: stuck.length + legacy.length };
  },
});

/** Delete every copy whose month is over, a batch at a time. */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("eodEmailCopies")
      .withIndex("by_expires", (q) => q.lte("expiresAt", Date.now()))
      .take(BATCH);
    for (const c of due) await ctx.db.delete(c._id);
    const daily = await ctx.db.query("dailyEmails").withIndex("by_expires", q => q.gt("expiresAt", 0).lte("expiresAt", Date.now()))
      .filter(q => q.and(q.neq(q.field("status"), "sending"), q.neq(q.field("status"), "uncertain"))).take(BATCH);
    for (const email of daily) {
      // An uncertain send needs its payload to recover. Keep it until resolved.
      await ctx.db.patch(email._id, { snapshot: undefined, fields: {}, expiresAt: undefined });
    }
    const files = await ctx.db.query("dailyEmailAttachments").withIndex("by_expires", q => q.lte("expiresAt", Date.now())).take(BATCH);
    for (const file of files) {
      const emails = await ctx.db.query("dailyEmails").withIndex("by_job", q => q.eq("jobId", file.jobId)).collect();
      const references = emails.filter(e => (e.snapshot as DailyEmailSnapshot | undefined)?.attachments?.some(a => a.id === file._id));
      const held = references.filter(e => ["sending", "uncertain"].includes(e.status) || (e.expiresAt ?? 0) > Date.now());
      if (held.length) {
        await ctx.db.patch(file._id, { expiresAt: Math.max(Date.now() + 86400000, ...held.map(e => e.expiresAt ?? 0)) });
      } else {
        await ctx.storage.delete(file.storageId);
        await ctx.db.delete(file._id);
      }
    }
    if (due.length === BATCH || daily.length === BATCH) await ctx.scheduler.runAfter(0, internal.ta.eodCopies.purgeExpired, {});
    return { deleted: due.length };
  },
});

/** Release-pipeline migration. Deleted content cannot be reconstructed. */
export const normalizeRetention = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const emails = await ctx.db.query("dailyEmails").collect();
    const affected = emails.filter(e => e.status === "accepted" && !!e.snapshot && e.acceptedAt && (e.expiresAt ?? 0) < e.acceptedAt + EMAIL_RETENTION_MS);
    if (!args.dryRun) for (const email of affected) {
      const expiresAt = email.acceptedAt! + EMAIL_RETENTION_MS;
      await ctx.db.patch(email._id, { expiresAt });
      for (const a of (email.snapshot as DailyEmailSnapshot).attachments ?? []) {
        const file = await ctx.db.get(a.id as Id<"dailyEmailAttachments">);
        if (file) await ctx.db.patch(file._id, { expiresAt: Math.max(file.expiresAt, expiresAt) });
      }
    }
    const legacy = (await ctx.db.query("eodEmailCopies").collect()).filter(c => c.sentAt + EMAIL_RETENTION_MS > Date.now()).sort((a, b) => a.sentAt - b.sentAt);
    const adopted = new Set(emails.map(e => e.legacyCopyId));
    const missing = legacy.filter(c => !adopted.has(c._id));
    if (!args.dryRun) {
      const roots = new Map(emails.filter(e => e.legacyCopyId && !e.parentId && e.roundId).map(e => [e.roundId!, e._id]));
      for (const copy of missing) {
        const sender = await ctx.db.get(copy.sentBy);
        const round = await ctx.db.get(copy.roundId);
        const root = roots.get(copy.roundId);
        const mode = copy.effort?.hundredOrFollowUp;
        const workType = mode === "Follow-up" || mode === "Add-on" ? mode : "100%";
        const id = await ctx.db.insert("dailyEmails", { userId: copy.sentBy, jobId: copy.openingId,
          date: workdayDate(round?.sentAt ?? copy.sentAt), submissionType: "eod", status: "accepted", number: 1, revision: 0,
          fields: {}, applicationIds: copy.applicationIds, roundId: copy.roundId, legacyCopyId: copy._id,
          ...(root ? { parentId: root } : {}), workType, createdAt: copy.sentAt, acceptedAt: copy.sentAt, finalizedAt: copy.sentAt,
          expiresAt: copy.sentAt + EMAIL_RETENTION_MS,
          snapshot: { ...copy, from: sender?.email ?? "", workType, attachmentNames: [],
            html: eodEmailHtml({ rows: copy.rows, effort: copy.effort, senderName: sender?.fullName ?? "", introText: copy.introText, outroText: copy.outroText, researchLink: copy.researchLink, refereeCalls: copy.refereeCalls }) },
        });
        if (!root) roots.set(copy.roundId, id);
      }
    }
    return { dryRun: args.dryRun, affected: affected.length, legacyCopiesToImport: missing.length };
  },
});
