import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { BACKGROUND_ALERT_ROLLOUT } from "../../src/lib/backgroundAlerts";

/** Release-pipeline only. No historical job or candidate timestamps are rewritten. */
export const initialize = internalMutation({ args: { dryRun: v.boolean() }, handler: async (ctx, args) => {
  const existing = await ctx.db.query("taSettings").withIndex("by_key", q => q.eq("key", BACKGROUND_ALERT_ROLLOUT)).first();
  if (existing) return { initialized: true, startedAt: Number(existing.value), changed: false };
  const now = Date.now();
  if (!args.dryRun) await ctx.db.insert("taSettings", { key: BACKGROUND_ALERT_ROLLOUT, value: String(now), updatedAt: now });
  return { initialized: !args.dryRun, startedAt: now, changed: !args.dryRun };
} });
