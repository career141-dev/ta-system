import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Transactional application-level lock against rapid double-clicks or two
 * recruiters scheduling the same candidate concurrently.
 */
export async function assertNoPendingVoiceCall(
  ctx: MutationCtx,
  applicationId: Id<"applications">,
) {
  const existing = await ctx.db
    .query("aiCalls")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .filter((q) =>
      q.or(
        q.eq(q.field("callStatus"), "scheduled"),
        q.eq(q.field("callStatus"), "in_progress"),
      ),
    )
    .first();

  if (existing) {
    throw new Error("A voice call is already scheduled or in progress");
  }
}
