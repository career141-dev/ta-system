// convex/ta/users.ts
//
// Giving the TA platform's people accounts in this deployment.
//
// The two systems were populated separately: this deployment has 23 users who
// signed in through Clerk, and the TA platform has its own roster. Only a
// couple of addresses appear in both, so most TAs currently cannot act here at
// all — `resolveActor` would find nobody to be.
//
// This matches on email, which is the only thing the two rosters share, and it
// UPDATES rather than replaces: an existing user keeps their Clerk
// `tokenIdentifier` and their backend `role`, and gains the three fields the
// TA platform needs. Overwriting `role` here would quietly re-grade people who
// already have a considered role in this deployment.
//
// Users who exist only on the TA platform are created with a synthetic
// `tokenIdentifier` (`ta-platform|<email>`). That value can never match a real
// Clerk token, so these accounts are reachable through `actorId` and through
// nothing else — which is exactly right for someone who has no Clerk login.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc } from "../_generated/dataModel";

/** The TA platform's roles, mapped to this deployment's vocabulary. */
const ROLE_MAP: Record<string, string> = {
  admin: "admin",
  // A TA lead is desk-wide on the TA platform, and `ta_manager` is the role
  // here that carries the same reach (including the job-assignment bypass).
  ta_lead: "ta_manager",
  director: "director",
  ta: "recruiter",
  ops: "ops",
  client: "client",
  viewer: "viewer",
};

const TA_TOKEN_PREFIX = "ta-platform|";

const taUser = v.object({
  email: v.string(),
  fullName: v.string(),
  taRole: v.string(),
  routingEmail: v.optional(v.union(v.string(), v.null())),
  initials: v.optional(v.string()),
  isActive: v.optional(v.boolean()),
});

/**
 * Create or update this deployment's users from the TA platform's roster.
 *
 * Idempotent: running it twice changes nothing the second time. Returns what
 * it did per address so a dry run can be read before anything is trusted.
 */
export const upsertTaUsers = mutation({
  args: {
    users: v.array(taUser),
    /** Report what would happen and write nothing. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const results: {
      email: string;
      action: "created" | "updated" | "unchanged";
      userId: string | null;
      note?: string;
    }[] = [];

    for (const input of args.users) {
      const email = input.email.trim().toLowerCase();
      if (!email) {
        results.push({ email: input.email, action: "unchanged", userId: null, note: "no email" });
        continue;
      }

      const existing = await findByEmail(ctx, email);
      const taRole = input.taRole;
      const mappedRole = ROLE_MAP[taRole] ?? "recruiter";

      // The three fields the TA platform needs, and nothing else.
      const taFields = {
        routingEmail: input.routingEmail ?? null,
        initials: input.initials ?? initialsOf(input.fullName),
        taRole: taRole as Doc<"users">["taRole"],
      };

      if (existing) {
        const same =
          existing.routingEmail === taFields.routingEmail &&
          existing.initials === taFields.initials &&
          existing.taRole === taFields.taRole;
        if (same) {
          results.push({ email, action: "unchanged", userId: existing._id });
          continue;
        }
        if (!args.dryRun) await ctx.db.patch(existing._id, taFields);
        results.push({
          email,
          action: "updated",
          userId: existing._id,
          // Said out loud: their backend role is left as it is on purpose.
          note: `kept existing role "${existing.role}"`,
        });
        continue;
      }

      if (args.dryRun) {
        results.push({ email, action: "created", userId: null, note: `would be "${mappedRole}"` });
        continue;
      }

      const id = await ctx.db.insert("users", {
        tokenIdentifier: `${TA_TOKEN_PREFIX}${email}`,
        email,
        fullName: input.fullName,
        role: mappedRole as Doc<"users">["role"],
        isActive: input.isActive ?? true,
        // requireUser refuses anyone not onboarded, and these accounts have no
        // onboarding step to go through — they arrive already decided.
        isOnboarded: true,
        createdAt: new Date().toISOString(),
        ...taFields,
      });
      results.push({ email, action: "created", userId: id, note: `role "${mappedRole}"` });
    }

    return {
      dryRun: args.dryRun === true,
      created: results.filter((r) => r.action === "created").length,
      updated: results.filter((r) => r.action === "updated").length,
      unchanged: results.filter((r) => r.action === "unchanged").length,
      results,
    };
  },
});

/** Everyone who can act from the TA platform, with what the routing needs. */
export const listTaUsers = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("users").collect();
    return all
      .filter((u) => u.taRole !== undefined)
      .map((u) => ({
        _id: u._id as string,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        taRole: u.taRole ?? null,
        routingEmail: u.routingEmail ?? null,
        initials: u.initials ?? null,
        isActive: u.isActive,
        /** True for accounts that exist only here, with no Clerk login. */
        taPlatformOnly: (u.tokenIdentifier ?? "").startsWith(TA_TOKEN_PREFIX),
      }));
  },
});

async function findByEmail(ctx: { db: any }, email: string) {
  const exact = await ctx.db
    .query("users")
    .withIndex("by_email", (q: any) => q.eq("email", email))
    .first();
  if (exact) return exact as Doc<"users">;
  const all = (await ctx.db.query("users").collect()) as Doc<"users">[];
  return all.find((u) => (u.email ?? "").trim().toLowerCase() === email) ?? null;
}

function initialsOf(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
