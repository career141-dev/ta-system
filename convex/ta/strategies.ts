// convex/ta/strategies.ts
//
// The Strategy Planner's list, loaded as data (8 Oct).
//
// The strategies a TA Lead chooses from are the desk's own and are edited in the
// app (/strategy/manage). This is how the first list gets in without anyone
// typing forty entries on the live site: a migration, run by the release
// pipeline (`run_function`), with a dry run to read before anything is written.
//
//   dryRun: true   → reports what would be added; writes nothing
//   dryRun absent  → adds the ones that are not on the list yet
//
// Idempotent: a name already on the list (any capitals, retired or not) is left
// alone, so running it twice changes nothing the second time.
//
// Internal, so it can only be run with the deployment's admin key.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export const seedCatalogue = internalMutation({
  args: {
    items: v.array(
      v.object({
        name: v.string(),
        description: v.optional(v.string()),
        group: v.optional(v.string()),
      }),
    ),
    /** The account the entries are recorded as created by: an admin or lead's email. */
    createdByEmail: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const email = args.createdByEmail.trim().toLowerCase();
    const all = await ctx.db.query("users").collect();
    const author = all.find((u) => (u.email ?? "").trim().toLowerCase() === email);
    if (!author) throw new Error(`No account for ${email}.`);

    const existing = await ctx.db.query("strategies").collect();
    const taken = new Set(existing.map((s) => s.name.trim().toLowerCase()));
    let order = existing.reduce((m, s) => Math.max(m, s.sortOrder), 0);

    const results: { name: string; action: "added" | "already there" | "skipped"; note?: string }[] = [];
    for (const item of args.items) {
      const name = item.name.trim();
      if (!name) {
        results.push({ name: item.name, action: "skipped", note: "no name" });
        continue;
      }
      if (taken.has(name.toLowerCase())) {
        results.push({ name, action: "already there" });
        continue;
      }
      taken.add(name.toLowerCase());
      if (!args.dryRun) {
        await ctx.db.insert("strategies", {
          name,
          description: item.description?.trim() || null,
          group: item.group?.trim() || null,
          sortOrder: ++order,
          active: true,
          createdAt: Date.now(),
          createdBy: author._id,
        });
      }
      results.push({ name, action: "added" });
    }
    return {
      dryRun: !!args.dryRun,
      added: results.filter((r) => r.action === "added").length,
      results,
    };
  },
});

// ─── Proof images (8 Oct) ────────────────────────────────────────────────────
//
// A TA may attach a picture to a strategy row as proof they did it. The web app
// uploads the bytes straight to storage (src/app/api/strategy-proof) and keeps
// only the storage id on the row; these are the three things it needs from here.
// Internal, like everything under convex/ta: reachable only with the admin key
// the TA server holds, which checks who may do what before it asks.

/** Where to put the picture. */
export const proofUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** A short-lived address for a stored picture, for the server to fetch and pass on. Null when it is gone. */
export const proofUrl = internalQuery({
  args: { storageId: v.string() },
  handler: async (ctx, args) => await ctx.storage.getUrl(args.storageId as Id<"_storage">),
});

/** Delete a stored picture. A missing one is not an error. */
export const proofDelete = internalMutation({
  args: { storageId: v.string() },
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId as Id<"_storage">).catch(() => {});
    return null;
  },
});
