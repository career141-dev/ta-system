// convex/ta/clients.ts
//
// The clients table, which the old system did not have.
//
// It kept `clientName` as free text on each job, so "DirectFN" and "DIRECTFN"
// were two clients with two separate histories and neither was complete. These
// rows are written by the backfill, folded on a normalised name.

import { mapIndustry } from "../lib/jobRequirements";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { optionalActor } from "./guard";

export const list = internalQuery({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const rows = await ctx.db.query("clients").collect();
    return rows
      // A client in the Bin (ta/bin.ts) has left the desk until it is restored.
      .filter((c) => !c.binnedAt)
      .map((c) => ({
        id: c._id as string,
        name: c.name,
        industry: c.industry,
        contacts: c.contacts ?? [],
        esaSignedAt: c.esaSignedAt ?? null,
        status: c.status,
        createdAt: c.createdAt,
        researchNotes: c.researchNotes ?? "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

function clientKey(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export const add = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    name: v.string(),
    industry: v.string(),
    contacts: v.optional(
      v.array(
        v.object({
          name: v.string(),
          title: v.string(),
          email: v.string(),
          isPrimary: v.boolean(),
        }),
      ),
    ),
    esaSignedAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const key = clientKey(args.name);
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_nameKey", (q) => q.eq("nameKey", key))
      .first();
    if (existing) {
      // Adding a client that is in the Bin brings that one back rather than
      // making a second record the Bin would later leave orphaned.
      if (existing.binnedAt) await ctx.db.patch(existing._id, { binnedAt: undefined, binnedBy: undefined });
      return existing._id as string;
    }
    const id = await ctx.db.insert("clients", {
      name: args.name.trim(),
      nameKey: key,
      industry: args.industry || "—",
      contacts: args.contacts ?? [],
      esaSignedAt: args.esaSignedAt ?? null,
      status: "active",
      createdAt: Date.now(),
    });
    return id as string;
  },
});

export const update = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    clientId: v.string(),
    name: v.optional(v.string()),
    industry: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("dormant"), v.literal("archived"))),
    esaSignedAt: v.optional(v.union(v.number(), v.null())),
    researchNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const id = ctx.db.normalizeId("clients", args.clientId);
    if (!id) return { ok: false };
    const patch: Record<string, any> = {};
    if (args.researchNotes !== undefined) patch.researchNotes = args.researchNotes.trim().slice(0, 2000);
    if (args.name !== undefined) {
      patch.name = args.name.trim();
      patch.nameKey = clientKey(args.name);
    }
    if (args.industry !== undefined) patch.industry = args.industry;
    if (args.status !== undefined) patch.status = args.status;
    if (args.esaSignedAt !== undefined) patch.esaSignedAt = args.esaSignedAt;
    await ctx.db.patch(id, patch);
    // The job keeps its own copy of the industry, and it never followed an
    // edit here (21 Sep). It does now — except where someone set the job's
    // industry by hand, which stays theirs.
    let jobsUpdated = 0;
    if (args.industry !== undefined) {
      const industry = mapIndustry(args.industry) ?? "Other";
      const jobs = await ctx.db.query("jobs").withIndex("by_clientId", (q) => q.eq("clientId", id)).collect();
      for (const job of jobs) {
        if ((job.requirementsLockedFields ?? []).includes("clientIndustry")) continue;
        if (job.clientIndustry === industry) continue;
        await ctx.db.patch(job._id, { clientIndustry: industry });
        jobsUpdated++;
      }
    }
    return { ok: true, jobsUpdated };
  },
});

// Deleting a client moves it to the Bin — see ta/bin.ts `binClient`.

export const saveContacts = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    clientId: v.string(),
    contacts: v.array(
      v.object({
        name: v.string(),
        title: v.string(),
        email: v.string(),
        isPrimary: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const id = ctx.db.normalizeId("clients", args.clientId);
    if (!id) return { ok: false };
    const cleaned = args.contacts.filter((x) => x.name.trim());
    if (cleaned.length && !cleaned.some((x) => x.isPrimary)) cleaned[0].isPrimary = true;
    let seen = false;
    for (const x of cleaned) {
      if (x.isPrimary && seen) x.isPrimary = false;
      if (x.isPrimary) seen = true;
    }
    await ctx.db.patch(id, { contacts: cleaned });
    return { ok: true };
  },
});

