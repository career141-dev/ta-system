// convex/stats/statsQueries.ts
import { query, internalQuery, action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

export const countAllCandidatesAction = action({
  args: {},
  handler: async (ctx) => {
    let total = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: any = await ctx.runQuery(internal.stats.statsQueries.getCandidatesPage, {
        cursor,
        limit: 50,
      });
      total += page.count || 0;
      isDone = page.isDone;
      cursor = page.continueCursor;
    }
    return { exactTotalCandidates: total };
  },
});

export const countAllCvUploadsAction = action({
  args: {},
  handler: async (ctx) => {
    let total = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: any = await ctx.runQuery(internal.stats.statsQueries.getCvUploadsPage, {
        cursor,
        limit: 500,
      });
      total += page.count || 0;
      isDone = page.isDone;
      cursor = page.continueCursor;
    }
    return { exactTotalCvUploads: total };
  },
});

export const getCandidatesPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const res = await ctx.db
      .query("candidates")
      .paginate({ numItems: limit, cursor: args.cursor });
    return {
      count: res.page.length,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

export const getCvUploadsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const res = await ctx.db
      .query("cvUploads")
      .paginate({ numItems: limit, cursor: args.cursor });
    return {
      count: res.page.length,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

export const getApplicationsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const res = await ctx.db
      .query("applications")
      .paginate({ numItems: limit, cursor: args.cursor });
    return {
      count: res.page.length,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

export const getJobsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const res = await ctx.db
      .query("jobs")
      .paginate({ numItems: limit, cursor: args.cursor });
    const activeCount = res.page.filter((j) => j.status === "active").length;
    return {
      count: res.page.length,
      activeCount,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

