/**
 * The automobile contact list behind the Extras tab (30 Oct). Twin of salesContacts.
 *
 * `refresh` reads every candidate in pages, keeps the people who have worked for an
 * automobile employer at any level (convex/lib/automobileRole), and saves them in
 * `automobileContacts` with a level.
 * It never writes to `candidates`. Run `refresh` with dryRun=true first: it only
 * counts. Live runs go through the release pipeline; the Extras Refresh button
 * calls `start`, which is admin-only.
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { requireActor } from "../ta/guard";
import { mapUser } from "../../src/data/convex/map";
import type { SalesLevel } from "../lib/salesRole";
import { automobileRoleOf } from "../lib/automobileRole";
import { canUseExtras } from "./salesContacts";

const PAGE = 100; // candidates carry big fields; a small page keeps each read well under the limit
const PAGES_PER_RUN = 15; // then the action reschedules itself, so no single run nears the time limit
const LEVELS: SalesLevel[] = ["manager", "executive", "intern", "other"];

async function requireAdmin(ctx: Parameters<typeof requireActor>[0], actorId: string) {
  const actor = await requireActor(ctx, actorId);
  if (!canUseExtras(mapUser(actor).role)) throw new Error("Only an admin can use Extras.");
  return actor;
}

/** One page of candidates: classify, and (unless dryRun) save. */
export const page = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), runId: v.string(), dryRun: v.boolean() },
  handler: async (ctx, { cursor, runId, dryRun }) => {
    const res = await ctx.db.query("candidates").paginate({ numItems: PAGE, cursor });
    const counts: Record<string, number> = {};
    let kept = 0;
    const now = Date.now();
    for (const c of res.page) {
      // Merged duplicates and do-not-contact people never reach a campaign list.
      if (c.mergedInto || c.isDuplicateOf || c.doNotContact) continue;
      const role = automobileRoleOf(c);
      if (!role) continue;
      kept++;
      counts[role.level] = (counts[role.level] ?? 0) + 1;
      if (dryRun) continue;
      const history = [...(c.jobHistory ?? [])].map((j) => [j.title, j.company].filter(Boolean).join(" at ")).filter(Boolean);
      const row = {
        candidateId: c._id,
        runId,
        name: (c.fullName ?? "").trim() || "(no name)",
        email: c.email?.trim().toLowerCase() || undefined,
        title: role.title,
        titleSource: role.titleSource,
        level: role.level,
        employer: c.currentEmployer?.trim() || undefined,
        phone: c.phone?.trim() || undefined,
        linkedinUrl: c.linkedinUrl?.trim() || undefined,
        experienceYears: c.totalExperienceYears,
        skills: (c.skills ?? []).slice(0, 15).join(", ") || undefined,
        previousRole: (history[1] ?? c.pastJobTitles?.[1])?.trim() || undefined,
        sector: c.sector?.trim() || undefined,
        matchedBy: role.matchedBy,
        updatedAt: now,
      };
      const existing = await ctx.db.query("automobileContacts").withIndex("by_candidate", (q) => q.eq("candidateId", c._id)).unique();
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("automobileContacts", row);
    }
    return { scanned: res.page.length, kept, counts, isDone: res.isDone, cursor: res.continueCursor };
  },
});

export const saveRun = internalMutation({
  args: {
    runId: v.string(), startedAt: v.number(), scanned: v.number(), kept: v.number(),
    counts: v.any(), dryRun: v.boolean(), finished: v.boolean(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("automobileContactRuns").withIndex("by_runId", (q) => q.eq("runId", a.runId)).unique();
    const row = {
      runId: a.runId, startedAt: a.startedAt, scanned: a.scanned, kept: a.kept, counts: a.counts, dryRun: a.dryRun,
      finishedAt: a.finished ? Date.now() : undefined,
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("automobileContactRuns", row);
  },
});

/** Delete rows an earlier run saved but this one did not see (the person changed jobs, or was merged). */
export const dropStale = internalMutation({
  args: { runId: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { runId, cursor }) => {
    const res = await ctx.db.query("automobileContacts").paginate({ numItems: 1000, cursor: cursor ?? null });
    let dropped = 0;
    for (const r of res.page) if (r.runId !== runId) { await ctx.db.delete(r._id); dropped++; }
    if (!res.isDone) await ctx.scheduler.runAfter(0, internal.extras.automobileContacts.dropStale, { runId, cursor: res.continueCursor });
    return { dropped };
  },
});

export const refresh = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    runId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    scanned: v.optional(v.number()),
    kept: v.optional(v.number()),
    counts: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const startedAt = args.startedAt ?? Date.now();
    const runId = args.runId ?? `run-${startedAt}`;
    let cursor = args.cursor ?? null;
    let scanned = args.scanned ?? 0;
    let kept = args.kept ?? 0;
    const counts: Record<string, number> = { ...(args.counts ?? {}) };
    let done = false;
    for (let i = 0; i < PAGES_PER_RUN && !done; i++) {
      const r = await ctx.runMutation(internal.extras.automobileContacts.page, { cursor, runId, dryRun });
      scanned += r.scanned;
      kept += r.kept;
      for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + (n as number);
      cursor = r.cursor;
      done = r.isDone;
    }
    await ctx.runMutation(internal.extras.automobileContacts.saveRun, { runId, startedAt, scanned, kept, counts, dryRun, finished: done });
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.extras.automobileContacts.refresh, { dryRun, runId, startedAt, cursor, scanned, kept, counts });
      return { dryRun, finished: false, scanned, kept, counts };
    }
    if (!dryRun) await ctx.runMutation(internal.extras.automobileContacts.dropStale, { runId, cursor: null });
    return { dryRun, finished: true, scanned, kept, counts };
  },
});

/** The Extras Refresh button. Does nothing if a refresh started in the last 30 minutes is still running. */
export const start = internalMutation({
  args: { actorId: v.string() },
  handler: async (ctx, { actorId }) => {
    await requireAdmin(ctx, actorId);
    const last = await ctx.db.query("automobileContactRuns").order("desc").first();
    if (last && !last.dryRun && !last.finishedAt && Date.now() - last.startedAt < 30 * 60_000)
      throw new Error("A refresh is already running. Wait for it to finish.");
    await ctx.scheduler.runAfter(0, internal.extras.automobileContacts.refresh, {});
  },
});

export const summary = internalQuery({
  args: { actorId: v.string() },
  handler: async (ctx, { actorId }) => {
    await requireAdmin(ctx, actorId);
    const runs = await ctx.db.query("automobileContactRuns").order("desc").take(5);
    const done = runs.find((r) => !r.dryRun && r.finishedAt);
    const running = runs.find((r) => !r.dryRun && !r.finishedAt && Date.now() - r.startedAt < 30 * 60_000);
    return {
      counts: (done?.counts ?? {}) as Record<string, number>,
      kept: done?.kept ?? 0,
      finishedAt: done?.finishedAt ?? null,
      running: running ? { scanned: running.scanned, startedAt: running.startedAt } : null,
    };
  },
});

export const list = internalQuery({
  args: {
    actorId: v.string(),
    level: v.optional(v.string()),
    hasEmail: v.optional(v.boolean()),
    search: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.actorId);
    const level = LEVELS.find((l) => l === a.level);
    const base = level
      ? ctx.db.query("automobileContacts").withIndex("by_level", (q) => q.eq("level", level))
      : ctx.db.query("automobileContacts");
    const res = await base.paginate({ numItems: Math.min(a.limit ?? 100, 500), cursor: a.cursor });
    const needle = (a.search ?? "").trim().toLowerCase();
    const rows = res.page
      .filter((r) => !a.hasEmail || r.email)
      .filter((r) => !needle || [r.name, r.title, r.employer, r.email].some((x) => x?.toLowerCase().includes(needle)))
      .map(({ _id, _creationTime, candidateId, runId, ...row }) => ({ id: String(_id), ...row }));
    return { rows, isDone: res.isDone, cursor: res.continueCursor };
  },
});

/** A download is a bulk export of personal data, so it is written to the activity log. */
export const logExport = internalMutation({
  args: { actorId: v.string(), level: v.optional(v.string()), rows: v.number() },
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx, a.actorId);
    await ctx.db.insert("activityLog", {
      actorId: actor._id,
      actorName: actor.fullName,
      action: "export_automobile_contacts",
      entityType: "automobileContacts",
      entityId: a.level ?? "all",
      metadata: { rows: a.rows },
      occurredAt: new Date().toISOString(),
    });
  },
});
