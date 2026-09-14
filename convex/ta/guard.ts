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
    .unique();

  if (!assignment) {
    throw new Error("You are not assigned to this job with the required role");
  }
}

/** The recruiter roles that may work an opening's pipeline. */
export const WORKS_THE_DESK = ["primary_recruiter", "supporting_recruiter", "director"];
