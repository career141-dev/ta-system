import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { resolveActor } from "./auth";

/**
 * Roles that have unrestricted, global access to all data and pages.
 * test_ta and other limited roles are intentionally excluded.
 * Add new roles here as the system evolves.
 */
export const FULL_ACCESS_ROLES = ["admin", "ta_manager", "senior_ta", "test_ta"] as const;

/**
 * Fetch the current authenticated user and validate they are active.
 *
 * This is the gate 13 modules actually call, so it — not `requireAuth` — is
 * where the TA platform's cookie sessions have to be understood. It delegates
 * to `resolveActor` (./auth), which tries Clerk first and only falls back to
 * `actorId` when there is no identity at all.
 *
 * `actorId` is optional, so every existing call site keeps its exact previous
 * behaviour: no argument means Clerk or nothing.
 */
export async function requireUser(
  ctx: QueryCtx | MutationCtx,
  actorId?: Id<"users"> | string | null,
) {
  const { user } = await resolveActor(ctx, actorId);
  return user;
}

// Require one of the provided roles
export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  allowedRoles: string[]
) {
  const user = await requireUser(ctx);
  if (!allowedRoles.includes(user.role)) {
    throw new Error(`[403] Access denied. Your role (${user.role}) does not have permission to execute this feature. Required role: ${allowedRoles.join(" | ")}`);
  }
  return user;
}

/**
 * Require full-access role (admin, ta_manager, senior_ta).
 * Call this at the top of any query that touches global data
 * (all candidates, all CVs, analytics, etc.).
 * test_ta users receive a 403-equivalent error.
 */
export async function requireFullAccess(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (!(FULL_ACCESS_ROLES as readonly string[]).includes(user.role)) {
    throw new Error(
      `[403] Access denied. Your role (${user.role}) does not have permission to access global data. Contact your administrator.`
    );
  }
  return user;
}

// Require that user is assigned to this job with one of the provided assignment roles
export async function requireJobAssignment(
  ctx: QueryCtx | MutationCtx,
  jobId: Id<"jobs">,
  requiredAssignmentRoles: string[]
) {
  const user = await requireUser(ctx);

  // Admins and TA Managers bypass job-level assignment checks
  if (["admin", "ta_manager"].includes(user.role)) return user;

  const assignment = await ctx.db
    .query("jobAssignments")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .filter((q) =>
      q.and(
        q.eq(q.field("userId"), user._id),
        q.eq(q.field("isActive"), true),
        q.or(...requiredAssignmentRoles.map(r => q.eq(q.field("assignmentRole"), r)))
      )
    )
    .unique();

  if (!assignment) {
    throw new Error("You are not assigned to this job with the required role");
  }
  return user;
}
