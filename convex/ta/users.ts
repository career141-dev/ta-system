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
import { internalMutation, internalQuery } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import { requireActor } from "./guard";

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
export const upsertTaUsers = internalMutation({
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

// ─── People and roles (admin only) ──────────────────────────────────────────

const deskRole = v.union(
  v.literal("admin"),
  v.literal("director"),
  v.literal("ta_lead"),
  v.literal("ta"),
  v.literal("ops"),
  v.literal("client"),
  v.literal("viewer"),
);

/**
 * An admin OF THE DESK: on the TA roster (explicit taRole) as admin.
 *
 * Deliberately not `effectiveDeskRole`: this deployment also holds the old
 * app's accounts, some with backend role "admin" and no taRole. They are not
 * on the desk roster and must neither manage it nor count as the "other admin"
 * that lets the last real one step down.
 */
const isActiveAdmin = (u: Doc<"users">) => u.isActive && u.taRole === "admin";

/**
 * Add a person, or change who they are and what they can do.
 *
 * Only an admin may call this, and that is decided HERE as well as in the app:
 * the People page is a courtesy, this is the check. The actor's role is read
 * from the database, never from the arguments.
 *
 * Changing a role writes both vocabularies — `taRole` for this platform and
 * the mapped backend `role` — because the backend's own guards (job-assignment
 * bypass, full-access reads) read `role`, and a person whose two roles
 * disagree has two different levels of access depending on which door they
 * use. (`upsertTaUsers` deliberately does not do this; that is a bulk import,
 * this is an admin's explicit decision.)
 *
 * The desk can never be left without an active admin.
 */
export const adminSaveUser = internalMutation({
  args: {
    actorId: v.string(),
    /** Absent to add someone new. */
    userId: v.optional(v.string()),
    fullName: v.string(),
    email: v.string(),
    phone: v.optional(v.union(v.string(), v.null())),
    routingEmail: v.optional(v.union(v.string(), v.null())),
    taRole: deskRole,
  },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    if (!isActiveAdmin(actor)) throw new Error("[403] Only an admin can manage people and roles.");

    const email = args.email.trim().toLowerCase();
    const fullName = args.fullName.trim();
    if (!fullName) throw new Error("A name is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email address is required.");

    const now = new Date().toISOString();
    const fields = {
      fullName,
      email,
      phone: args.phone?.trim() || undefined,
      routingEmail: args.routingEmail?.trim().toLowerCase() || null,
      taRole: args.taRole,
      role: (ROLE_MAP[args.taRole] ?? "viewer") as Doc<"users">["role"],
      initials: initialsOf(fullName),
      updatedAt: now,
    };

    if (!args.userId) {
      const sameEmail = await allWithEmail(ctx, email);
      if (sameEmail.some((u) => u.taRole)) {
        throw new Error(`${email} is already on the desk — use Edit on their row instead.`);
      }
      // An account from the older app, not yet on the desk: bring THAT record
      // onto the desk rather than refusing or creating a second one. Where the
      // older app left duplicates, take the one with a real Clerk login, newest.
      const adopt = sameEmail
        .slice()
        .sort((a, b) =>
          Number(!a.tokenIdentifier.startsWith(TA_TOKEN_PREFIX)) - Number(!b.tokenIdentifier.startsWith(TA_TOKEN_PREFIX)) ||
          a._creationTime - b._creationTime,
        )
        .pop();
      if (adopt) {
        await ctx.db.patch(adopt._id, { ...fields, isActive: true, isOnboarded: true });
        return { userId: adopt._id as string, action: "adopted" as const };
      }
      const id = await ctx.db.insert("users", {
        ...fields,
        tokenIdentifier: `${TA_TOKEN_PREFIX}${email}`,
        isActive: true,
        isOnboarded: true,
        createdAt: now,
      });
      return { userId: id as string, action: "created" as const };
    }

    let target: Doc<"users"> | null = null;
    try {
      target = await ctx.db.get(args.userId as Doc<"users">["_id"]);
    } catch {
      target = null;
    }
    if (!target) throw new Error("That person no longer exists.");
    // Only another DESK account at a DIFFERENT address conflicts. A second
    // desk record at the person's own address is the same person twice — the
    // roster import and their sign-in each made one — and refusing it left
    // binath@career141.com impossible to re-role (5 Oct). Those twins take the
    // same change, so the two records can never grant different access.
    const ownEmail = (target.email ?? "").trim().toLowerCase();
    const others = (await allWithEmail(ctx, email)).filter((u) => u.taRole && u._id !== target!._id);
    if (others.length && email !== ownEmail) {
      throw new Error(`${email} already belongs to someone else on the desk.`);
    }
    if (isActiveAdmin(target) && args.taRole !== "admin") await assertAnotherAdmin(ctx, ownEmail);

    for (const u of [target, ...others]) await ctx.db.patch(u._id, fields);
    return { userId: target._id as string, action: "updated" as const };
  },
});

/** Mark someone as left, or bring them back. Nobody is deleted. Admin only. */
export const adminSetUserActive = internalMutation({
  args: { actorId: v.string(), userId: v.string(), isActive: v.boolean() },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    if (!isActiveAdmin(actor)) throw new Error("[403] Only an admin can manage people and roles.");
    let target: Doc<"users"> | null = null;
    try {
      target = await ctx.db.get(args.userId as Doc<"users">["_id"]);
    } catch {
      target = null;
    }
    if (!target) throw new Error("That person no longer exists.");
    const ownEmail = (target.email ?? "").trim().toLowerCase();
    if (!args.isActive && isActiveAdmin(target)) await assertAnotherAdmin(ctx, ownEmail);
    // Left or back applies to every desk record of this address — one active
    // twin would otherwise keep a "left" person signed in.
    const twins = ownEmail ? (await allWithEmail(ctx, ownEmail)).filter((u) => u.taRole) : [];
    const now = new Date().toISOString();
    for (const u of twins.some((u) => u._id === target!._id) ? twins : [target, ...twins]) {
      await ctx.db.patch(u._id, { isActive: args.isActive, updatedAt: now });
    }
    return { ok: true };
  },
});

/**
 * Make an existing account a desk admin — for the first admin on a fresh
 * deployment, or to recover when no admin is left. Internal, so it can only be
 * run with the deployment's admin key:
 *
 *   npx convex run ta/users:bootstrapDeskAdmin '{"email":"someone@career141.com"}'
 */
export const bootstrapDeskAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await findByEmail(ctx, email);
    if (!user) throw new Error(`No account for ${email}.`);
    await ctx.db.patch(user._id, {
      taRole: "admin",
      role: "admin",
      isActive: true,
      isOnboarded: true,
      updatedAt: new Date().toISOString(),
    });
    return { userId: user._id as string, email };
  },
});

/** Every record with this address, case-insensitively — the older app left duplicates. */
async function allWithEmail(ctx: { db: any }, email: string): Promise<Doc<"users">[]> {
  const all = (await ctx.db.query("users").collect()) as Doc<"users">[];
  return all.filter((u) => (u.email ?? "").trim().toLowerCase() === email);
}

/**
 * Accounts in this deployment that are NOT on the desk roster — the older
 * app's users. The People page lists them so an admin can see why an address
 * "already has an account", and bring it onto the desk with a role.
 * One row per address; `duplicates` counts the extra records behind it.
 */
export const listOffDeskAccounts = internalQuery({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    if (!isActiveAdmin(actor)) throw new Error("[403] Only an admin can manage people and roles.");
    const all = (await ctx.db.query("users").collect()) as Doc<"users">[];
    const onDesk = new Set(all.filter((u) => u.taRole).map((u) => (u.email ?? "").trim().toLowerCase()));
    const byEmail = new Map<string, Doc<"users">[]>();
    for (const u of all) {
      const e = (u.email ?? "").trim().toLowerCase();
      if (!e || onDesk.has(e) || u.taRole) continue;
      byEmail.set(e, [...(byEmail.get(e) ?? []), u]);
    }
    return [...byEmail.entries()]
      .map(([email, rows]) => {
        const newest = rows.reduce((a, b) => (b._creationTime > a._creationTime ? b : a));
        return {
          email,
          fullName: newest.fullName,
          oldAppRole: newest.role,
          isActive: rows.some((r) => r.isActive),
          duplicates: rows.length - 1,
        };
      })
      .sort((a, b) => a.email.localeCompare(b.email));
  },
});

/**
 * Another PERSON is an active admin. Excludes by address, not record id: a
 * duplicate record of the same person is not a second admin, and counting it
 * would let the only real admin step down.
 */
async function assertAnotherAdmin(ctx: { db: any }, excludingEmail: string) {
  const all = (await ctx.db.query("users").collect()) as Doc<"users">[];
  if (!all.some((u) => (u.email ?? "").trim().toLowerCase() !== excludingEmail && isActiveAdmin(u))) {
    throw new Error("This is the last active admin. Make someone else an admin first.");
  }
}

/** Everyone who can act from the TA platform, with what the routing needs. */
export const listTaUsers = internalQuery({
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
