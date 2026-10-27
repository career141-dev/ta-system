import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireActor } from "./guard";
import { mapUser } from "../../src/data/convex/map";
import { canPairTaTracking, canViewTaTracking, validateTrackingRows, validTrackingDate, TRACKING_RETENTION_MS } from "../../src/lib/taTracking";

export const pair = internalMutation({
  args: { actorId: v.string(), tokenHash: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    if (!canPairTaTracking(mapUser(actor).role)) throw new Error("Tracking is unavailable for this account.");
    const existing = await ctx.db.query("taTrackingDevices").withIndex("by_token", q => q.eq("tokenHash", args.tokenHash)).unique();
    if (existing) {
      if (existing.userId !== actor._id || existing.expiresAt <= Date.now()) throw new Error("Start a new browser sign-in.");
      return;
    }
    const devices = await ctx.db.query("taTrackingDevices").withIndex("by_user", q => q.eq("userId", actor._id)).collect();
    if (devices.filter(d => d.expiresAt > Date.now()).length >= 10) throw new Error("Disconnect an existing browser before pairing another.");
    await ctx.db.insert("taTrackingDevices", { userId: actor._id, tokenHash: args.tokenHash, createdAt: Date.now(), expiresAt: Date.now() + 90 * 86400000, lastSyncAt: 0, enabled: false });
  },
});

export const upload = internalMutation({
  args: { tokenHash: v.string(), rows: v.any(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const device = await ctx.db.query("taTrackingDevices").withIndex("by_token", q => q.eq("tokenHash", args.tokenHash)).unique();
    if (!device || device.expiresAt <= Date.now()) return { ok: false as const };
    const user = await ctx.db.get(device.userId);
    if (!user?.isActive || !user.isOnboarded || !canPairTaTracking(mapUser(user).role)) return { ok: false as const };
    const rows = validateTrackingRows(args.rows);
    for (const row of rows) {
      const existing = await ctx.db.query("taTrackingRows").withIndex("by_device_date_domain", q => q.eq("deviceId", device._id).eq("date", row.date).eq("domain", row.domain)).unique();
      // Snapshots replace cumulative totals; replaying a request never adds time twice.
      if (!existing) await ctx.db.insert("taTrackingRows", { ...row, deviceId: device._id, userId: device.userId });
      else if (row.lastSeen >= existing.lastSeen && row.foregroundMs >= existing.foregroundMs && row.clicks >= existing.clicks && row.scrolls >= existing.scrolls && row.movementSeconds >= existing.movementSeconds) await ctx.db.patch(existing._id, row);
    }
    await ctx.db.patch(device._id, { lastSyncAt: Date.now(), enabled: args.enabled });
    return { ok: true as const, name: user.fullName, email: user.email.trim().toLowerCase() };
  },
});

export const report = internalQuery({
  args: { actorId: v.string(), date: v.string(), userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    if (!canViewTaTracking(mapUser(actor).role)) throw new Error("Only admins and TA leads can view TA Track.");
    if (!validTrackingDate(args.date)) throw new Error("Choose a date within the last 30 days.");
    const rows = await (args.userId
      ? ctx.db.query("taTrackingRows").withIndex("by_user_date", q => q.eq("userId", args.userId!).eq("date", args.date))
      : ctx.db.query("taTrackingRows").withIndex("by_date", q => q.eq("date", args.date))).take(10001);
    if (rows.length > 10000) throw new Error("Too many rows. Select one TA to narrow the report.");
    const devices = args.userId
      ? await ctx.db.query("taTrackingDevices").withIndex("by_user", q => q.eq("userId", args.userId!)).collect()
      : await ctx.db.query("taTrackingDevices").collect();
    const users = new Map((await ctx.db.query("users").collect()).map(user => [String(user._id), user.fullName]));
    return {
      rows: rows.filter(row => row.lastSeen >= Date.now() - TRACKING_RETENTION_MS).map(({ _id, _creationTime, deviceId, ...row }) => ({ ...row, name: users.get(String(row.userId)) ?? "Unknown TA" })),
      devices: devices.map(d => ({ userId: d.userId, lastSyncAt: d.lastSyncAt, enabled: d.enabled && d.expiresAt > Date.now() })),
    };
  },
});

export const disconnect = internalMutation({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const devices = await ctx.db.query("taTrackingDevices").withIndex("by_user", q => q.eq("userId", actor._id)).collect();
    for (const device of devices) await ctx.db.patch(device._id, { expiresAt: 0, enabled: false });
  },
});

export const purgeExpired = internalMutation({
  args: {}, handler: async ctx => {
    const rows = await ctx.db.query("taTrackingRows").withIndex("by_lastSeen", q => q.lt("lastSeen", Date.now() - TRACKING_RETENTION_MS)).take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
  },
});
