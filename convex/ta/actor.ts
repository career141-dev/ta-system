// convex/ta/actor.ts
//
// The bridge between the TA platform's session and this deployment's users.
//
// The two systems number their people differently: the TA platform's signed
// cookie names a user like `u_lead`, and this deployment's users are Convex
// documents. Nothing maps one to the other except the email address, so that
// is what the bridge matches on — and it matches it HERE, on the server, so a
// caller never gets to nominate a Convex id directly from a cookie.
//
// The flow the TA platform uses:
//
//   1. read the signed cookie              → the TA user, with an email
//   2. `lookupByEmail(email)`               → this deployment's user id
//   3. any function, with `actorId` set     → attributed to that person
//
// Step 2 failing is a real answer, not an error to paper over: a TA who has no
// account in this deployment should be told so, rather than having their work
// silently recorded against nobody.

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireUser } from "../lib/permissions";

/**
 * This deployment's user for a given email, or null.
 *
 * Returns only what the caller needs to decide what to do next — never the
 * token identifier, which is Clerk's and has no business leaving the backend.
 */
export const lookupByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!email) return null;

    // The index is on the stored spelling, so an exact hit is tried first and
    // a case-insensitive scan only where that misses. The table holds 23 rows;
    // this is not a scan worth optimising away, and addresses in it are not
    // consistently cased.
    const exact = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (exact) return project(exact);

    const all = await ctx.db.query("users").collect();
    const found = all.find((u) => (u.email ?? "").trim().toLowerCase() === email);
    return found ? project(found) : null;
  },
});

function project(u: {
  _id: unknown;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  isOnboarded?: boolean;
}) {
  return {
    _id: u._id as string,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    isActive: u.isActive,
    isOnboarded: u.isOnboarded ?? false,
  };
}

/**
 * Proves the dual-mode adapter end to end.
 *
 * `getActiveJobsBasicInfo` — the proof-of-concept the integration uses — is a
 * plain query with no auth check at all, so it demonstrates that the transport
 * works and nothing about whether the actor was understood. This one goes
 * through `requireUser`, which is the gate the other 13 modules call, so a
 * successful reply here means the cookie session really did authenticate.
 */
export const whoami = query({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.actorId ?? null);
    return {
      userId: user._id as string,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      // How it was established. `actor_id` here is the whole point: it means
      // there was no Clerk identity and the fallback carried the request.
      source: (await ctx.auth.getUserIdentity()) ? "clerk" : "actor_id",
    };
  },
});
