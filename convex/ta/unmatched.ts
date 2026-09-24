// convex/ta/unmatched.ts
//
// CVs from the shared mailboxes that matched no job post.
//
// With post routing on, an application whose link, code and title match no
// post goes to the database and nowhere else (pipeline/postFiling.ts, 22
// September). No TA sees it: a TA's view is the rows on their own posts. This
// is the list a lead reads to place them by hand. A CV leaves it once the
// person is on any opening.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const MAILBOX_CHANNELS = ["linkedin", "email", "email_campaign"] as const;
const MAX_ROWS = 200;

export const list = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const since = Date.now() - (args.days ?? 14) * 24 * 60 * 60_000;
    const rows: {
      candidateId: string;
      name: string | null;
      subject: string | null;
      note: string | null;
      source: string;
      from: string | null;
      receivedAt: number;
    }[] = [];
    const seen = new Set<Id<"candidates">>();

    for (const channel of MAILBOX_CHANNELS) {
      const logs = await ctx.db
        .query("ingestionLog")
        .withIndex("by_channel_time", (q) => q.eq("channelType", channel).gte("receivedAt", since))
        .order("desc")
        // ponytail: newest 2,000 log rows per mailbox, well inside a query's read
        // limit; linkedin@ took 507 in one morning (16 September). If a fortnight
        // ever outgrows it, the oldest drop off first — add an index on
        // routingStatus + receivedAt then.
        .take(2000);
      for (const log of logs) {
        if (log.routingStatus !== "unrouted" || !log.cvFileId) continue;
        const upload = await ctx.db.get(log.cvFileId);
        const candidateId = upload?.candidateId ?? log.candidateId;
        // Not read yet, or already listed from another email.
        if (!candidateId || seen.has(candidateId)) continue;
        seen.add(candidateId);
        // Placed since — by a lead, or by a later email that did match.
        const placed = await ctx.db
          .query("applications")
          .withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId))
          .first();
        if (placed) continue;
        const candidate = await ctx.db.get(candidateId);
        if (!candidate) continue;
        rows.push({
          candidateId: candidateId as string,
          name: candidate.fullName ?? log.candidateName ?? null,
          subject: upload?.metaHeadline ?? null,
          note: upload?.routeNote ?? null,
          source: channel,
          from: log.rawSender ?? null,
          receivedAt: log.receivedAt,
        });
      }
    }
    return rows.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, MAX_ROWS);
  },
});
