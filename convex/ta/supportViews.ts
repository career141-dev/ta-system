import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { requireActor } from "./guard";
import { mapUser } from "../../src/data/convex/map";
import { must } from "../../src/lib/auth";
import type { DailyEmailSnapshot } from "../../src/lib/dailyEmail";
import type { SupportEodPage } from "../../src/lib/supportEod";

/** Read-only projection; normal TA email reads and all write guards are unchanged. */
export const eod = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs"), date: v.string(), taId: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SupportEodPage> => {
    const actor = await requireActor(ctx, args.actorId);
    must(mapUser(actor), "tables.readAll");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.binnedAt !== undefined) throw new Error("This position is unavailable.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date) || Number.isNaN(Date.parse(args.date))) throw new Error("Select a valid date.");
    const taId = args.taId ? ctx.db.normalizeId("users", args.taId) : null;
    let query = ctx.db.query("dailyEmails").withIndex("by_job_date", q => q.eq("jobId", args.jobId).eq("date", args.date));
    query = query.filter(q => q.and(q.eq(q.field("submissionType"), "eod"), ...(args.taId ? [q.eq(q.field("userId"), taId)] : [])));
    const page = await query.order("desc").paginate({ cursor: args.cursor ?? null, numItems: 8 });
    return {
      emails: page.page.map(email => {
        const saved = email.snapshot as DailyEmailSnapshot | undefined;
        const retained = !!email.expiresAt && email.expiresAt > Date.now();
        return { id: email._id, userId: email.userId, date: email.date, status: email.status,
          workLocationName: email.workLocationName, revision: email.revision,
          acceptedAt: email.acceptedAt, subject: retained ? saved?.subject : undefined,
          html: retained ? saved?.html : undefined, effort: retained ? saved?.effort : undefined };
      }),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
