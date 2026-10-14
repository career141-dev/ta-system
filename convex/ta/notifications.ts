// convex/ta/notifications.ts
//
// In-app notifications — a discrete, one-time event for a person ("you were
// assigned to X"), as opposed to Alerts (src/lib/sla.ts), which are ongoing
// reminders recomputed live from the record. A notification is written once,
// when the event happens, and is read until dismissed.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { stillActive } from "./backgroundAlerts";

const NOTIFICATION_TYPE = v.union(
  v.literal("candidate_placed_elsewhere"),
  v.literal("candidate_placed"),
  v.literal("sla_breached"),
  v.literal("reverse_match_ready"),
  v.literal("candidate_replied"),
  v.literal("candidate_unresponsive"),
  v.literal("opening_assigned"),
  // CVs the Director, a TA Lead or Ops mailed to the TA (mailIntake, 27 Sep).
  v.literal("scoop_received"),
  // A TA Lead gave the TA strategies on a job (Strategy Planner, 8 Oct).
  v.literal("strategy_assigned"),
  v.literal("job_no_new_candidates"),
  v.literal("director_no_shortlist"),
);

export const create = internalMutation({
  args: {
    userId: v.string(),
    type: NOTIFICATION_TYPE,
    title: v.string(),
    body: v.string(),
    jobId: v.optional(v.string()),
    href: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("notifications", {
      userId: args.userId as Id<"users">,
      type: args.type,
      title: args.title,
      body: args.body,
      jobId: args.jobId ? (args.jobId as Id<"jobs">) : undefined,
      read: false,
      createdAt: new Date().toISOString(),
      href: args.href,
    });
    return { id: id as string };
  },
});

/** Newest first, capped — a bell panel, not an archive. */
export const listForUser = internalQuery({
  args: {
    userId: v.string(),
    unreadOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", args.userId as Id<"users">))
      .collect();
    const visible = [];
    for (const row of rows) {
      if (row.alertId) {
        const alert = await ctx.db.get(row.alertId);
        if (!alert || !await stillActive(ctx, alert)) continue;
        visible.push({ ...row, body: alert.detail });
        continue;
      }
      visible.push(row);
    }
    const filtered = args.unreadOnly ? visible.filter((r) => !r.read) : visible;
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const unreadCount = visible.filter((r) => !r.read).length;
    return {
      unreadCount,
      notifications: filtered.slice(0, args.limit ?? 30).map((n) => ({
        id: n._id as string,
        type: n.type,
        title: n.title,
        body: n.body,
        jobId: (n.jobId ?? null) as string | null,
        href: n.href ?? null,
        read: n.read,
        createdAt: n.createdAt,
      })),
    };
  },
});

export const markRead = internalMutation({
  args: { userId: v.string(), notificationId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.notificationId as Id<"notifications">);
    if (!row || row.userId !== (args.userId as Id<"users">)) return { ok: false };
    await ctx.db.patch(row._id, { read: true });
    return { ok: true };
  },
});

export const markAllRead = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) => q.eq("userId", args.userId as Id<"users">).eq("read", false))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { read: true });
    return { ok: true, count: rows.length };
  },
});
