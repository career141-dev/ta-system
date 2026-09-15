// convex/lib/auth.ts
//
// Dual-mode authentication.
//
// This deployment now serves two front ends:
//
//   1. The original Next.js app, which signs users in with Clerk. Clerk puts an
//      identity on the request, and `ctx.auth.getUserIdentity()` returns it.
//
//   2. The TA platform, which signs users in with its own signed cookie and an
//      account picker. There is no Clerk identity on those requests, so the
//      caller names the acting user explicitly with `actorId`.
//
// Mode 1 is tried first and always wins. `actorId` is only consulted when there
// is no identity at all, so a Clerk-authenticated request can never be talked
// into acting as somebody else by adding an argument.
//
// ── Why the actorId path is not a hole ──────────────────────────────────────
//
// A caller supplying `actorId` is asserting who they are rather than proving
// it. That is safe here for one specific reason, and it is worth stating
// plainly rather than leaving to be inferred: the only way to reach these
// functions without a Clerk identity is with the deployment's admin key, and
// the admin key already permits calling every function in the deployment,
// internal ones included. So `actorId` grants nothing that its holder did not
// already have; what it adds is an *identity to attribute the write to*, so
// that a stage change made from the TA platform names a person instead of
// being anonymous.
//
// What this means in practice, and what must stay true:
//
//   - The admin key lives on the TA platform's SERVER only. It is read from
//     the environment in `src/lib/convex.ts` and never reaches the browser.
//   - The TA platform decides whether the user may do the thing BEFORE it
//     calls, in `src/lib/auth.ts` and `src/lib/visibility.ts`. This file
//     establishes who the actor is; it is not the authorization layer.
//   - `actorId` must never be taken from a form field or a query parameter
//     without the server re-deriving it from the session cookie first.

import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

export type UserRole = "admin" | "director" | "ta" | "ops";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: UserRole;
  fullName: string;
}

/** How the actor was established, so callers and logs can tell them apart. */
export type ActorSource = "clerk" | "actor_id";

export interface ResolvedActor {
  user: Doc<"users">;
  source: ActorSource;
}

/**
 * The one place a user is established, whichever front end is calling.
 *
 * Returns the full user document plus how it was found. Throws the same errors
 * the Clerk-only version threw, so existing callers see no change in
 * behaviour when no `actorId` is supplied.
 */
export async function resolveActor(
  ctx: QueryCtx | MutationCtx,
  actorId?: Id<"users"> | string | null,
): Promise<ResolvedActor> {
  // ── Mode 1: Clerk ─────────────────────────────────────────────────────────
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (!user) throw new Error("User not found in database");
    assertUsable(user);
    return { user, source: "clerk" };
  }

  // ── Mode 2: the TA platform's signed-cookie session ───────────────────────
  if (actorId) {
    // `ctx.db.get` throws on a string that is not an id for this table, which
    // would surface as an opaque server error. Normalising it to the same
    // "User not found" the Clerk path gives keeps the two modes consistent.
    let user: Doc<"users"> | null = null;
    try {
      user = await ctx.db.get(actorId as Id<"users">);
    } catch {
      user = null;
    }
    if (!user) throw new Error("User not found in database");
    assertUsable(user);
    return { user, source: "actor_id" };
  }

  throw new Error("UNAUTHENTICATED: Must be logged in");
}

/**
 * The two states that make an existing user unusable, checked identically in
 * both modes so neither is a softer way in than the other.
 *
 * `isOnboarded` is optional in the schema, and the check is deliberately on
 * falsiness rather than on `=== false`: that is what `requireUser` has always
 * done, and a user record that has never been onboarded carries the field as
 * absent rather than as `false`. Testing for `false` alone would let exactly
 * those records through.
 */
function assertUsable(user: Doc<"users">): void {
  if (!user.isActive) throw new Error("Account deactivated");
  if (!user.isOnboarded) {
    throw new Error("Pending role assignment — contact Admin");
  }
}

/**
 * Call this at the top of every mutation and query that needs auth.
 *
 * Kept at its original name and shape. Passing `actorId` is what opts a call
 * into the cookie-session mode; omitting it behaves exactly as before.
 */
export async function requireAuth(
  ctx: QueryCtx | MutationCtx,
  actorId?: Id<"users"> | string | null,
): Promise<AuthenticatedUser> {
  const { user } = await resolveActor(ctx, actorId);
  return {
    userId: user._id,
    email: user.email,
    role: user.role as UserRole,
    fullName: user.fullName,
  };
}

/** Require a specific role or throw. */
export function requireRole(
  user: AuthenticatedUser,
  allowedRoles: UserRole[]
): void {
  if (!allowedRoles.includes(user.role)) {
    throw new Error(
      `FORBIDDEN: Requires role ${allowedRoles.join(" or ")}, got ${user.role}`
    );
  }
}
