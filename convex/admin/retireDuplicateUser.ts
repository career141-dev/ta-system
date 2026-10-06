/**
 * Take the extra desk record of one person off the desk.
 *
 * Why this exists: binath@career141.com had two user records, both on the desk
 * — the roster import made one and the sign-in made another. The People page
 * showed the person twice, and changing their role failed with "already
 * belongs to someone else on the desk" (5 Oct).
 *
 * The extra record is RETIRED, not deleted: its desk role is cleared and it is
 * marked inactive. Dozens of fields across the schema point at user ids
 * (application owners, assignments, notes…), and a deleted record would leave
 * whatever it touched pointing at nobody. A retired one is simply off the
 * roster — not listed, not counted as a second admin, not a duplicate.
 *
 * The record kept is the one the app signs this address in as (the same
 * lookup as `ta/actor:lookupByEmail`), so the person's access and history stay
 * where they already are.
 *
 * Two steps, run by the release pipeline (run_function), never from a laptop:
 *
 *   1. {"email": "binath@career141.com"}                  → dry run. Shows every
 *                                                           record, which is
 *                                                           kept, and what work
 *                                                           each one holds.
 *   2. {"email": "binath@career141.com", "dryRun": false} → retires the extras.
 *
 * `keepId` overrides which record is kept, if the dry run shows the wrong one.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export const run = internalMutation({
  args: {
    email: v.string(),
    /** Keep this record instead of the one sign-in resolves to. */
    keepId: v.optional(v.string()),
    /** FALSE retires the extras. Omit it to see the records first. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const email = args.email.trim().toLowerCase();
    if (!email) throw new Error("An email is required. Nothing was changed.");

    const all = (await ctx.db.query("users").collect()) as Doc<"users">[];
    const same = all.filter((u) => (u.email ?? "").trim().toLowerCase() === email);
    if (!same.length) throw new Error(`No records for ${email}. Nothing was changed.`);

    // The record sign-in resolves to: an exact hit on the index first, then
    // a case-insensitive match — the order lookupByEmail uses.
    const signedIn =
      (await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).first()) ?? same[0];
    const keep = args.keepId ? same.find((u) => u._id === args.keepId) : signedIn;
    if (!keep) throw new Error(`keepId is not one of the records for ${email}. Nothing was changed.`);

    const rows = await Promise.all(
      same.map(async (u) => ({
        userId: u._id as string,
        fullName: u.fullName,
        storedEmail: u.email,
        taRole: u.taRole ?? null,
        role: u.role,
        isActive: u.isActive,
        clerkLogin: !(u.tokenIdentifier ?? "").startsWith("ta-platform|"),
        createdAt: u.createdAt ?? new Date(u._creationTime).toISOString(),
        signInResolvesHere: u._id === signedIn._id,
        // Work held by the record, as a sense of which one is in use.
        applicationsOwned: (
          await ctx.db
            .query("applications")
            .withIndex("by_owner", (q) => q.eq("ownerTaId", u._id as Id<"users">))
            .take(1000)
        ).length,
        action: u._id === keep._id ? "keep" : u.taRole || u.isActive ? "retire" : "already off the desk",
      })),
    );
    const extras = same.filter((u) => u._id !== keep._id && (u.taRole || u.isActive));

    if (!extras.length) return { dryRun, changed: false, reason: "Only one record is on the desk.", rows };
    // Never leave the desk without an admin: if the admin role sits on an
    // extra, it would go with it. Make the kept record an admin first.
    const retiring = new Set(extras.map((u) => u._id));
    if (!all.some((u) => !retiring.has(u._id) && u.isActive && u.taRole === "admin")) {
      throw new Error("Retiring these would leave no active admin. Give the kept record the admin role first. Nothing was changed.");
    }
    if (dryRun) {
      return { dryRun: true, keep: keep._id as string, rows, next: 'To retire the extras, run again with "dryRun": false.' };
    }
    const now = new Date().toISOString();
    for (const u of extras) await ctx.db.patch(u._id, { taRole: undefined, isActive: false, updatedAt: now });
    return { dryRun: false, changed: true, keep: keep._id as string, retired: extras.map((u) => u._id as string), rows };
  },
});
