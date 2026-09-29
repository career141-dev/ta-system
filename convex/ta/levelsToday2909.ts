// convex/ta/levelsToday2909.ts
//
// Excel Tables rows added on 29 September into L1 (the desk, 29 Sep).
//
// L's arrived that day (PR #83): a TA starts L1, L2… with the + beside Excel
// Tables, and a row goes into their latest L. Rows added earlier that day,
// before anyone had pressed +, are in no L. The owner asked for the day's rows
// to be L1 — each TA's own L1 on each opening, as L's are numbered per TA.
//
// For every row created that Colombo day with no L: the TA's L1 on that
// opening is made if they have none (started at the beginning of the day),
// brought back if they had deleted it, and the row is put in it. Rows already
// in an L are left alone. Nothing is deleted.
//
// Run by the release pipeline (AGENTS.md rule 5):
//   run_function  ta/levelsToday2909:run   run_args  {"dryRun": true}
// then {"dryRun": false}. Idempotent: a second run finds nothing to do.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const COLOMBO_OFFSET_MS = 5.5 * 3_600_000;

/** Midnight in Colombo at the start of `day` ("2026-09-29"), in ms. */
function colomboMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - COLOMBO_OFFSET_MS;
}

type Level = { at: number; name?: string; deleted?: boolean };

/** The same reading the app does (store.allLinkLevels): old entries were bare start times. */
function readLevels(value: string | undefined): Level[] {
  try {
    const arr: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(arr) ? arr.map((x) => (typeof x === "number" ? { at: x } : (x as Level))) : [];
  } catch {
    return [];
  }
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()), day: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const day = args.day ?? "2026-09-29";
    const from = colomboMidnight(day);
    const to = from + 86_400_000;

    // Excel Tables is small next to the candidate tables — a few thousand rows.
    const rows = (await ctx.db.query("linkVault").collect()).filter(
      (r) => r.createdAt >= from && r.createdAt < to && !(r as Doc<"linkVault"> & { level?: number | null }).level,
    );

    // One L1 per TA per opening.
    const groups = new Map<string, Doc<"linkVault">[]>();
    for (const r of rows) {
      const key = `link_levels:${r.openingId}:${r.addedBy}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }

    let made = 0;
    let restored = 0;
    const perTa: { opening: string; ta: string; rows: number; l1: "made" | "restored" | "kept" }[] = [];
    for (const [key, group] of groups) {
      const setting = await ctx.db.query("taSettings").withIndex("by_key", (q) => q.eq("key", key)).first();
      const levels = readLevels(setting?.value);
      let l1: "made" | "restored" | "kept" = "kept";
      if (levels.length === 0) {
        levels.push({ at: from });
        l1 = "made";
        made++;
      } else if (levels[0].deleted) {
        delete levels[0].deleted;
        l1 = "restored";
        restored++;
      }
      perTa.push({ opening: String(group[0].openingId), ta: String(group[0].addedBy), rows: group.length, l1 });
      if (dryRun) continue;
      if (l1 !== "kept") {
        const value = JSON.stringify(levels);
        if (setting) await ctx.db.patch(setting._id, { value, updatedAt: Date.now() });
        else await ctx.db.insert("taSettings", { key, value, updatedAt: Date.now() });
      }
      for (const r of group) await ctx.db.patch(r._id, { level: 1 });
    }

    return {
      dryRun,
      day,
      rowsIntoL1: rows.length,
      tas: groups.size,
      l1Made: made,
      l1Restored: restored,
      perTa: perTa.slice(0, 50),
    };
  },
});
