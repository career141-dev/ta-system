// Excel Tables rows saved before their TA started L1 (15 Oct).
//
// addLink now starts L1 automatically, but existing production rows need a
// one-time repair. Only rows that can be identified safely are moved:
//   - when the TA has never had an L, their unlevelled rows become L1;
//   - when L1 already exists, only rows saved no later than L1's start become L1.
// Rows from a deleted L stay unlevelled. A deleted L is never restored.
//
// Run only through the release pipeline (AGENTS.md rule 5), scoped to the job
// first so the dry-run result can be checked:
//   run_function ta/unlevelledLinks1510:run
//   run_args {"dryRun":true,"openingId":"<job id>"}
// then repeat with "dryRun":false after reviewing the returned groups.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

type Level = { at: number; name?: string; deleted?: boolean };

function readLevels(value: string | undefined): Level[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.map((level) => typeof level === "number" ? { at: level } : (level as Level))
      : [];
  } catch {
    return [];
  }
}

export const run = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    openingId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const rows = await ctx.db.query("linkVault").withIndex("by_opening", (q) => q.eq("openingId", args.openingId)).collect();
    const unlevelled = rows.filter((row) => !(row as Doc<"linkVault"> & { level?: number | null }).level);

    const groups = new Map<string, Doc<"linkVault">[]>();
    for (const row of unlevelled) {
      const key = `link_levels:${row.openingId}:${row.addedBy}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    let rowsIntoL1 = 0;
    let l1Made = 0;
    let skippedDeletedL1 = 0;
    let skippedAfterL1 = 0;
    const perTa: {
      opening: string;
      ta: string;
      moved: number;
      skipped: number;
      l1: "made" | "kept" | "deleted";
    }[] = [];

    for (const [key, group] of groups) {
      const setting = await ctx.db.query("taSettings").withIndex("by_key", (q) => q.eq("key", key)).first();
      const levels = readLevels(setting?.value);
      const first = levels[0];
      const eligible = !first
        ? group
        : first.deleted
          ? []
          : group.filter((row) => row.createdAt <= first.at);
      const skipped = group.length - eligible.length;
      if (first?.deleted) skippedDeletedL1 += skipped;
      else skippedAfterL1 += skipped;

      const sample = group[0];
      perTa.push({
        opening: String(sample.openingId),
        ta: String(sample.addedBy),
        moved: eligible.length,
        skipped,
        l1: !first ? "made" : first.deleted ? "deleted" : "kept",
      });
      if (eligible.length === 0) continue;

      rowsIntoL1 += eligible.length;
      if (!first) l1Made++;
      if (dryRun) continue;

      if (!first) {
        const at = Math.min(...eligible.map((row) => row.createdAt));
        const value = JSON.stringify([{ at }]);
        if (setting) await ctx.db.patch(setting._id, { value, updatedAt: Date.now() });
        else await ctx.db.insert("taSettings", { key, value, updatedAt: Date.now() });
      }
      for (const row of eligible) await ctx.db.patch(row._id, { level: 1 });
    }

    return {
      dryRun,
      openingId: String(args.openingId),
      unlevelledRows: unlevelled.length,
      rowsIntoL1,
      l1Made,
      skippedDeletedL1,
      skippedAfterL1,
      perTa: perTa.slice(0, 100),
    };
  },
});
