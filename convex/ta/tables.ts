// convex/ta/tables.ts
//
// Reading any TA table in the app's shape, a page at a time.
//
// Before this, only users, openings, clients, applications and named candidates
// were ever loaded, so every other table — interviews, offers, placements,
// review rounds, the link vault, intake, follow-up records, settings — read as
// empty in the app, and anything that looked one of its rows up first was
// refused with "That record no longer exists".

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { optionalActor } from "./guard";
import { TABLES } from "./model/tables";

/** Tables the store loads whole. The large shared ones have their own scoped reads. */
const WHOLE = new Set([
  "briefs", "jobPosts", "assignments", "pipelineEvents", "reviewRounds", "linkVault", "alerts",
  "savedSearches", "savedReports", "researchReports", "benchmarks", "suggestions", "chat", "jdChat", "intake",
  "outreach", "offers", "placements", "esaRecords", "aiCalls", "settings", "matchRuns",
  "matchExclusions", "callFeedback", "interviews",
]);

export const page = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    table: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    if (!WHOLE.has(args.table)) throw new Error(`"${args.table}" is not loaded whole; use its scoped read.`);
    const model = TABLES[args.table];
    const res = await ctx.db
      .query(model.backend as never)
      .paginate({ cursor: args.cursor ?? null, numItems: Math.min(args.numItems ?? 500, 1000) });
    const docs = res.page as Record<string, unknown>[];
    // A revoked assignment is history, not a current assignment.
    const live = args.table === "assignments" ? docs.filter((d) => d.isActive !== false) : docs;
    return {
      rows: live.map((d) => model.fromDoc(d as never)),
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

/** Referees for the candidates the app has loaded — 33,000 in all, so never whole. */
export const refereesFor = internalQuery({
  args: { actorId: v.optional(v.string()), candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const model = TABLES.referees;
    const out = [];
    const lists = await Promise.all(
      args.candidateIds.slice(0, 1000).map((id) => {
        const cid = ctx.db.normalizeId("candidates", id);
        return cid
          ? ctx.db.query("referees").withIndex("by_candidateId", (q) => q.eq("candidateId", cid)).collect()
          : Promise.resolve([]);
      }),
    );
    for (const list of lists) for (const d of list) out.push(model.fromDoc(d as never));
    return out;
  },
});
