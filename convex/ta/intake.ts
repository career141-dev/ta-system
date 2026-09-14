// convex/ta/intake.ts
//
// The queue in front of the candidate table.
//
// The backend's own ingestion writes a candidate as soon as a file arrives and
// lets deduplication merge or drop it, which means nobody ever sees the ones
// it got wrong. Here a CV that arrives is a row in `intakeItems` and nothing
// else: it becomes a candidate only when a person admits it.
//
// This module owns the queue. Turning an admitted item INTO a candidate and an
// application is the backend's job and stays there — plan step 9 wires the
// connectors to this queue, and admission calls the existing
// `applications:createApplication`.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, optionalActor} from "./guard";

function project(i: Doc<"intakeItems">) {
  return {
    id: i._id as string,
    source: i.source,
    receivedFrom: i.receivedFrom ?? null,
    receivedAt: i.receivedAt,
    fileName: i.fileName ?? null,
    fileHash: i.fileHash ?? null,
    status: i.status,
    parsed: i.parsed ?? null,
    match: i.match ?? null,
    toAddress: i.toAddress ?? null,
    subject: i.subject ?? null,
    openingId: (i.openingId ?? null) as string | null,
    jobPostId: (i.jobPostId ?? null) as string | null,
    routedToTaId: (i.routedToTaId ?? null) as string | null,
    routeNote: i.routeNote ?? null,
    routeConfidence: i.routeConfidence ?? null,
    candidateId: (i.candidateId ?? null) as string | null,
    problems: i.problems ?? [],
    note: i.note ?? null,
  };
}

export const list = query({
  args: {
    actorId: v.optional(v.string()),
    status: v.optional(v.string()),
    /** Only what arrived at this TA's mailbox. */
    mineOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);

    const rows = args.status
      ? await ctx.db
          .query("intakeItems")
          .withIndex("by_status", (q) => q.eq("status", args.status as Doc<"intakeItems">["status"]))
          .collect()
      : await ctx.db.query("intakeItems").collect();

    // Same rule as the openings list: "mine" is unanswerable without a person.
    if (args.mineOnly && !user) {
      throw new Error("mineOnly needs an actorId — there is nobody to scope the queue to.");
    }
    const scoped = args.mineOnly && user ? rows.filter((r) => r.routedToTaId === user._id) : rows;
    scoped.sort((a, b) => b.receivedAt - a.receivedAt);
    return scoped.slice(0, args.limit ?? 200).map(project);
  },
});

export const get = query({
  args: { actorId: v.optional(v.string()), itemId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const item = await ctx.db.get(args.itemId as Id<"intakeItems">);
    return item ? project(item) : null;
  },
});

/** How many are waiting, by status — the queue's headline. */
export const counts = query({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const rows = await ctx.db.query("intakeItems").collect();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
    return { total: rows.length, byStatus: out };
  },
});

/**
 * Put a CV in the queue.
 *
 * `fileHash` is checked first because it is the cheapest and most certain
 * dedup factor there is: the same bytes arriving twice is the same file, and
 * saying so costs one indexed read. Returning the existing row rather than
 * inserting a duplicate makes this safe to call from a retrying webhook.
 */
export const receive = mutation({
  args: {
    actorId: v.optional(v.string()),
    source: v.string(),
    receivedFrom: v.optional(v.union(v.string(), v.null())),
    fileName: v.optional(v.union(v.string(), v.null())),
    fileHash: v.optional(v.union(v.string(), v.null())),
    sizeBytes: v.optional(v.union(v.number(), v.null())),
    rawText: v.optional(v.union(v.string(), v.null())),
    s3Key: v.optional(v.union(v.string(), v.null())),
    toAddress: v.optional(v.union(v.string(), v.null())),
    subject: v.optional(v.union(v.string(), v.null())),
    // Routing is decided by src/lib/routing.ts before this is called, and
    // passed in. This module stores the decision; it does not make it.
    openingId: v.optional(v.union(v.string(), v.null())),
    jobPostId: v.optional(v.union(v.string(), v.null())),
    routedToTaId: v.optional(v.union(v.string(), v.null())),
    routeNote: v.optional(v.union(v.string(), v.null())),
    routeConfidence: v.optional(v.union(v.string(), v.null())),
    problems: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);

    if (args.fileHash) {
      const dupe = await ctx.db
        .query("intakeItems")
        .withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash!))
        .first();
      if (dupe) return { id: dupe._id as string, duplicate: true };
    }

    const id = await ctx.db.insert("intakeItems", {
      source: args.source,
      receivedFrom: args.receivedFrom ?? null,
      receivedAt: Date.now(),
      fileName: args.fileName ?? null,
      fileHash: args.fileHash ?? null,
      sizeBytes: args.sizeBytes ?? null,
      rawText: args.rawText ?? null,
      s3Key: args.s3Key ?? null,
      status: "received" as const,
      toAddress: args.toAddress ?? null,
      subject: args.subject ?? null,
      openingId: (args.openingId ?? null) as Id<"jobs"> | null,
      jobPostId: (args.jobPostId ?? null) as Id<"jobPosts"> | null,
      routedToTaId: (args.routedToTaId ?? null) as Id<"users"> | null,
      routeNote: args.routeNote ?? null,
      routeConfidence: args.routeConfidence ?? null,
      candidateId: null,
      handledBy: null,
      handledAt: null,
      note: null,
      problems: args.problems ?? [],
    });
    return { id: id as string, duplicate: false };
  },
});

/** Record what was read out of the file, and what dedup concluded. */
export const setParsed = mutation({
  args: {
    actorId: v.optional(v.string()),
    itemId: v.string(),
    parsed: v.optional(v.any()),
    match: v.optional(v.any()),
    status: v.optional(v.string()),
    problems: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    const id = args.itemId as Id<"intakeItems">;
    if (!(await ctx.db.get(id))) throw new Error("Intake item not found");

    await ctx.db.patch(id, {
      ...(args.parsed !== undefined ? { parsed: args.parsed } : {}),
      ...(args.match !== undefined ? { match: args.match } : {}),
      ...(args.status !== undefined ? { status: args.status as Doc<"intakeItems">["status"] } : {}),
      ...(args.problems !== undefined ? { problems: args.problems } : {}),
    });
    return { ok: true };
  },
});

/**
 * Close an item out: admitted, merged into somebody, or rejected.
 *
 * `admitted` and `merged` both name the candidate they became, which is what
 * makes the queue auditable after the fact — "this row is now that person".
 * Only a person reaches this, which is the whole point of the queue.
 */
export const resolve = mutation({
  args: {
    actorId: v.optional(v.string()),
    itemId: v.string(),
    outcome: v.union(v.literal("admitted"), v.literal("merged"), v.literal("rejected")),
    candidateId: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const id = args.itemId as Id<"intakeItems">;
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Intake item not found");

    if ((args.outcome === "admitted" || args.outcome === "merged") && !args.candidateId) {
      throw new Error(`An item marked "${args.outcome}" has to name the candidate it became.`);
    }

    await ctx.db.patch(id, {
      status: args.outcome,
      candidateId: (args.candidateId ?? null) as Id<"candidates"> | null,
      handledBy: user._id,
      handledAt: Date.now(),
      note: args.note ?? item.note ?? null,
    });
    return { ok: true };
  },
});
