// convex/ta/bin.ts
//
// The Bin: where a deleted client or opening waits seven days before it is
// removed for good (asked for 28 Sep — a delete pressed by mistake took a whole
// opening's pipeline with it and nothing could bring it back).
//
// Binning removes nothing. The row is stamped `binnedAt` and every list skips
// it (src/lib/bin.ts `isGone`). An opening is also set to cancelled, because
// the follow-up sweep, CV routing and WhatsApp matching only look at active or
// on-hold openings — so a binned opening stops messaging candidates and stops
// catching CVs at once, and Restore puts its old status back.
//
// After seven days the daily clean-up (`emptyDue`, crons.ts) hands the opening
// to the existing batched delete (ta/openingDelete.ts), which keeps every
// candidate. A client goes once none of its openings are left.

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { requireActor, optionalActor } from "./guard";
import { MAY_DELETE_OPENINGS } from "./openingDelete";
import { BIN_MS, isGone, purgeAt } from "../../src/lib/bin";

/** Hand an opening to the batched delete. Its candidates stay. */
async function purgeOpening(ctx: MutationCtx, job: Doc<"jobs">, by?: Id<"users">) {
  if (job.deletingAt) return;
  await ctx.db.patch(job._id, { deletingAt: Date.now(), ...(by ? { deletingBy: by } : {}) });
  await ctx.scheduler.runAfter(0, internal.ta.openingDelete.step, { jobId: job._id });
}

/** Openings under a client that are still on the desk (not binned or deleting). */
async function liveOpeningsFor(ctx: MutationCtx, clientId: Id<"clients">) {
  const rows = await ctx.db.query("jobs").withIndex("by_clientId", (q) => q.eq("clientId", clientId)).collect();
  return rows.filter((j) => !isGone(j));
}

/** Delete pressed on an opening: into the Bin. */
export const binOpening = internalMutation({
  args: { actorId: v.string(), openingId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    if (!MAY_DELETE_OPENINGS.includes(user.role)) {
      throw new Error("Only an admin, TA manager, director or ops can delete an opening. Close it instead.");
    }
    const jobId = ctx.db.normalizeId("jobs", args.openingId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!job || job.deletingAt) throw new Error("That opening no longer exists.");
    if (job.binnedAt) return { ok: true as const, title: job.title, purgeAt: purgeAt(job.binnedAt) };

    const now = Date.now();
    await ctx.db.patch(job._id, {
      binnedAt: now,
      binnedBy: user._id,
      statusBeforeBin: job.status,
      status: "cancelled",
      updatedAt: new Date(now).toISOString(),
    });
    return { ok: true as const, title: job.title, purgeAt: purgeAt(now) };
  },
});

/**
 * Delete pressed on a client: into the Bin — but only once nothing on the desk
 * is filed under it. Binning a client with live openings would hide them with
 * it, and nobody deleting a duplicate client record means to do that.
 */
export const binClient = internalMutation({
  args: { actorId: v.optional(v.string()), clientId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const id = ctx.db.normalizeId("clients", args.clientId);
    const client = id ? await ctx.db.get(id) : null;
    if (!client) return { ok: false as const, openings: 0, missing: true };
    const live = await liveOpeningsFor(ctx, client._id);
    if (live.length > 0) return { ok: false as const, openings: live.length };
    if (client.binnedAt) return { ok: true as const, name: client.name, purgeAt: purgeAt(client.binnedAt) };
    const now = Date.now();
    await ctx.db.patch(client._id, { binnedAt: now, binnedBy: user._id });
    return { ok: true as const, name: client.name, purgeAt: purgeAt(now) };
  },
});

/**
 * Take something back out of the Bin, exactly as it was. Anybody on the desk
 * may — undoing a delete loses nothing.
 */
export const restore = internalMutation({
  args: { actorId: v.string(), kind: v.union(v.literal("opening"), v.literal("client")), id: v.string() },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    if (args.kind === "opening") {
      const jobId = ctx.db.normalizeId("jobs", args.id);
      const job = jobId ? await ctx.db.get(jobId) : null;
      if (!job || job.deletingAt) throw new Error("That opening has already been deleted for good.");
      if (!job.binnedAt) return { ok: true as const, name: job.title };
      await ctx.db.patch(job._id, {
        binnedAt: undefined,
        binnedBy: undefined,
        status: job.statusBeforeBin ?? "on_hold",
        statusBeforeBin: undefined,
        updatedAt: new Date().toISOString(),
      });
      // An opening cannot sit under a client nobody can see.
      const client = job.clientId ? await ctx.db.get(job.clientId) : null;
      if (client?.binnedAt) await ctx.db.patch(client._id, { binnedAt: undefined, binnedBy: undefined });
      return { ok: true as const, name: job.title, clientRestored: !!client?.binnedAt };
    }
    const id = ctx.db.normalizeId("clients", args.id);
    const client = id ? await ctx.db.get(id) : null;
    if (!client) throw new Error("That client has already been deleted for good.");
    if (client.binnedAt) await ctx.db.patch(client._id, { binnedAt: undefined, binnedBy: undefined });
    return { ok: true as const, name: client.name };
  },
});

/** Skip the seven days. A desk decision, like deleting an opening. */
export const deleteNow = internalMutation({
  args: { actorId: v.string(), kind: v.union(v.literal("opening"), v.literal("client")), id: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    if (!MAY_DELETE_OPENINGS.includes(user.role)) {
      throw new Error("Only an admin, TA manager, director or ops can empty the Bin early.");
    }
    if (args.kind === "opening") {
      const jobId = ctx.db.normalizeId("jobs", args.id);
      const job = jobId ? await ctx.db.get(jobId) : null;
      if (!job || job.deletingAt) return { ok: true as const, name: job?.title ?? "The opening" };
      if (!job.binnedAt) throw new Error("Only something in the Bin can be deleted for good.");
      await purgeOpening(ctx, job, user._id);
      return { ok: true as const, name: job.title };
    }
    const id = ctx.db.normalizeId("clients", args.id);
    const client = id ? await ctx.db.get(id) : null;
    if (!client) return { ok: true as const, name: "The client" };
    if (!client.binnedAt) throw new Error("Only something in the Bin can be deleted for good.");
    const under = await ctx.db.query("jobs").withIndex("by_clientId", (q) => q.eq("clientId", client._id)).collect();
    if (under.length > 0) {
      throw new Error(
        `${client.name} still has ${under.length} opening${under.length === 1 ? "" : "s"} in the Bin. Delete those first.`,
      );
    }
    await ctx.db.delete(client._id);
    return { ok: true as const, name: client.name };
  },
});

/** What is in the Bin, newest first, for the Bin page. */
export const list = internalQuery({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const jobs = await ctx.db.query("jobs").withIndex("by_binnedAt", (q) => q.gt("binnedAt", 0)).collect();
    const clients = await ctx.db.query("clients").withIndex("by_binnedAt", (q) => q.gt("binnedAt", 0)).collect();
    const names = new Map<string, string>();
    const nameOf = async (id?: Id<"users">) => {
      if (!id) return null;
      if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.fullName ?? "Someone");
      return names.get(id)!;
    };
    const openings = [];
    for (const j of jobs) {
      // Already handed to the batched delete: on its way out, not restorable.
      if (j.deletingAt) continue;
      const client = j.clientId ? await ctx.db.get(j.clientId) : null;
      openings.push({
        id: j._id as string,
        title: j.title,
        clientName: client?.name ?? j.clientName,
        binnedAt: j.binnedAt!,
        binnedBy: await nameOf(j.binnedBy),
        purgeAt: purgeAt(j.binnedAt!),
      });
    }
    const clientRows = [];
    for (const c of clients) {
      clientRows.push({
        id: c._id as string,
        name: c.name,
        industry: c.industry,
        binnedAt: c.binnedAt!,
        binnedBy: await nameOf(c.binnedBy),
        purgeAt: purgeAt(c.binnedAt!),
      });
    }
    openings.sort((a, b) => b.binnedAt - a.binnedAt);
    clientRows.sort((a, b) => b.binnedAt - a.binnedAt);
    return { openings, clients: clientRows };
  },
});

/**
 * The daily clean-up: anything binned seven days ago goes for good.
 *
 * Deletes only our own records and sends nothing, so it runs wherever the
 * maintenance crons do. Openings go first; a client waits until the last of
 * its openings has finished deleting, which may be the next day's run.
 */
export const emptyDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - BIN_MS;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_binnedAt", (q) => q.gt("binnedAt", 0).lte("binnedAt", cutoff))
      .collect();
    let openings = 0;
    for (const job of jobs) {
      if (job.deletingAt) continue;
      await purgeOpening(ctx, job);
      openings++;
    }
    const clients = await ctx.db
      .query("clients")
      .withIndex("by_binnedAt", (q) => q.gt("binnedAt", 0).lte("binnedAt", cutoff))
      .collect();
    let removed = 0;
    let waiting = 0;
    for (const client of clients) {
      const under = await ctx.db.query("jobs").withIndex("by_clientId", (q) => q.eq("clientId", client._id)).first();
      if (under) {
        waiting++;
        continue;
      }
      await ctx.db.delete(client._id);
      removed++;
    }
    if (openings || removed || waiting) {
      console.log(`[Bin] ${openings} opening(s) sent for deletion, ${removed} client(s) removed, ${waiting} client(s) waiting on their openings.`);
    }
    return { openings, clients: removed, waiting };
  },
});
