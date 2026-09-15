import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Query subscriptions expiring before a given threshold timestamp.
 */
export const getExpiringSubs = internalQuery({
  args: {
    expiryThreshold: v.number(),
  },
  handler: async (ctx, args) => {
    // Fetch all subscriptions and filter for those expiring soon
    const allSubs = await ctx.db.query("graphSubscriptions").collect();
    return allSubs.filter((s) => s.expiresAt < args.expiryThreshold);
  },
});

/**
 * Update the expiresAt field for a subscription after renewal.
 */
export const updateSubExpiry = internalMutation({
  args: {
    id: v.id("graphSubscriptions"),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { expiresAt: args.expiresAt });
  },
});

/**
 * Insert a new subscription record.
 */
export const insertSub = internalMutation({
  args: {
    subscriptionId: v.string(),
    taEmail: v.string(),
    resource: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("graphSubscriptions", {
      subscriptionId: args.subscriptionId,
      taEmail: args.taEmail,
      resource: args.resource,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
  },
});
