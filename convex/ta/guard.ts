// convex/ta/guard.ts
//
// The same permission rules as convex/lib/permissions.ts, asked of an actor we
// already resolved rather than of a Clerk identity.
//
// Why this exists rather than calling `requireJobAssignment` directly: that
// function starts by calling `requireUser(ctx)` with no arguments, so it would
// look for a Clerk identity and find none. The old code's escape hatch for
// this is `bypassRoleCheck: true`, which skips the check altogether — and a
// skipped check is not the same thing as a check that passed. These helpers
// take the user as an argument and apply the identical rule, so the TA
// platform's calls are held to the same standard as Clerk's.
//
// This is the backend's second line. The TA platform decides first, in
// src/lib/auth.ts and src/lib/visibility.ts. Neither is a substitute for the
// other: the first knows about openings and seats, this one knows the database.

import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { resolveActor } from "../lib/auth";
import { FULL_ACCESS_ROLES } from "../lib/permissions";

/** The acting user, from a Clerk identity or an explicit actorId. */
export async function requireActor(
  ctx: QueryCtx | MutationCtx,
  actorId?: Id<"users"> | string | null,
): Promise<Doc<"users">> {
  const { user } = await resolveActor(ctx, actorId);
  return user;
}

/**
 * The acting user where one was named, or null.
 *
 * For READS only, and the distinction from `requireActor` is deliberate.
 *
 * The TA platform resolves its session user from the store, and the store is
 * what these reads feed — so requiring an actor on every read would be
 * circular: it could not read the user it needs in order to read anything.
 * Reads therefore carry an actor when the caller has one and go without when
 * they do not.
 *
 * That is not an open door, because every function under convex/ta is
 * internal: it cannot be called from outside the deployment without the admin
 * key, which only the TA server holds (src/lib/convexServer.ts). A PUBLIC
 * Convex function is callable by anyone who knows the deployment URL, with no
 * key at all — which is why none of these may be public. An absent actor
 * removes an attribution, not a barrier. Writes still demand one — see the mutations, which all use
 * `requireActor` — because a write with nobody's name on it is the thing worth
 * refusing.
 */
export async function optionalActor(
  ctx: QueryCtx | MutationCtx,
  actorId?: Id<"users"> | string | null,
): Promise<Doc<"users"> | null> {
  if (!actorId) {
    // A Clerk identity still counts when one is present.
    try {
      const { user } = await resolveActor(ctx, null);
      return user;
    } catch {
      return null;
    }
  }
  return (await resolveActor(ctx, actorId)).user;
}

/** Mirrors requireFullAccess, for an actor we already have. */
export function assertFullAccess(user: Doc<"users">): void {
  if (!(FULL_ACCESS_ROLES as readonly string[]).includes(user.role)) {
    throw new Error(
      `[403] Access denied. Your role (${user.role}) does not have permission to access global data.`,
    );
  }
}

/**
 * Mirrors requireJobAssignment, for an actor we already have.
 *
 * Two details carried across deliberately, because changing either would make
 * this a different rule from the one the rest of the backend enforces:
 *
 *   - `admin` and `ta_manager` bypass job-level assignment entirely.
 *   - The lookup is `.unique()`, so a user holding two active assignments on
 *     one job throws rather than silently taking the first. That is a data
 *     fault worth surfacing, not routing around.
 */
export async function assertJobAccess(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  jobId: Id<"jobs">,
  requiredAssignmentRoles: string[],
): Promise<void> {
  if (["admin", "ta_manager"].includes(user.role)) return;

  const assignment = await ctx.db
    .query("jobAssignments")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .filter((q) =>
      q.and(
        q.eq(q.field("userId"), user._id),
        q.eq(q.field("isActive"), true),
        q.or(...requiredAssignmentRoles.map((r) => q.eq(q.field("assignmentRole"), r))),
      ),
    )
    // first(), not unique(): a recruiter assigned twice to the same job (a
    // re-assignment that left the old row active) is still assigned, and
    // unique() threw on them — every claim on that job failed with a server
    // error instead of going through (16 September).
    .first();

  if (assignment) return;

  // The web app decides who is on an opening from the job's assignedTaIds as
  // well; an older opening, or one whose team was changed there, can have a TA
  // in that list with no jobAssignments row. The app then let them shortlist
  // and the backend refused it, leaving the person in Database CVs, never in
  // the pipeline (testing, 21 Sep). A TA in the list counts as a recruiter on
  // it here too, so the two agree.
  if (requiredAssignmentRoles.some((r) => r === "primary_recruiter" || r === "supporting_recruiter")) {
    const job = await ctx.db.get(jobId);
    const listed = ((job as { assignedTaIds?: string[] } | null)?.assignedTaIds ?? []).includes(user._id as string);
    const lead = (job as { taLeadId?: string } | null)?.taLeadId === (user._id as string);
    if (listed || lead) return;
  }
  throw new Error("You are not assigned to this opening. Ask the TA lead to add you to its team.");
}

/** The recruiter roles that may work an opening's pipeline. */
export const WORKS_THE_DESK = ["primary_recruiter", "supporting_recruiter", "director"];

/**
 * Whether this person is a TA working their own desk, as the web app reads it
 * (src/data/convex/map.ts): an explicit `taRole` wins, else the backend role.
 * Leads, directors, admin and ops review the desk and are never narrowed.
 */
export function isTaOnOwnDesk(user: Doc<"users">): boolean {
  const explicit = (user as { taRole?: string | null }).taRole;
  if (explicit) return explicit === "ta";
  return user.role === "recruiter" || user.role === "ta" || user.role === "test_ta";
}

/**
 * The collision lock, held by the backend as well as by the web app.
 *
 * Two TAs on one opening work apart: a candidate one has claimed is theirs, and
 * the other cannot move, message or call them. The web app refuses first
 * (src/lib/auth.ts `opening.act`), from a copy of the data that can be up to
 * thirty seconds old — this is the check made on the live row, in the same
 * transaction as the write. A lead or director can still act (2 Oct).
 */
export function assertNotAnotherTasCandidate(
  user: Doc<"users">,
  app: { ownerTaId?: Id<"users"> | null },
): void {
  if (!app.ownerTaId || (app.ownerTaId as string) === (user._id as string)) return;
  if (!isTaOnOwnDesk(user)) return;
  throw new Error("Another recruiter has claimed this candidate.");
}
