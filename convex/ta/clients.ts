// convex/ta/clients.ts
//
// The clients table, which the old system did not have.
//
// It kept `clientName` as free text on each job, so "DirectFN" and "DIRECTFN"
// were two clients with two separate histories and neither was complete. These
// rows are written by the backfill, folded on a normalised name.

import { v } from "convex/values";
import { query } from "../_generated/server";
import { optionalActor } from "./guard";

export const list = query({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const rows = await ctx.db.query("clients").collect();
    return rows
      .map((c) => ({
        id: c._id as string,
        name: c.name,
        industry: c.industry,
        contacts: c.contacts ?? [],
        esaSignedAt: c.esaSignedAt ?? null,
        status: c.status,
        createdAt: c.createdAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
