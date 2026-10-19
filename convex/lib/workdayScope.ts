import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { mapUser } from "../../src/data/convex/map";
import { workdayDate } from "../../src/lib/workday";

/** Once a TA starts using workdays, another position requires its approval. */
export async function assertWorkdayScope(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  jobId: Id<"jobs">,
) {
  if (!["ta", "ta_support"].includes(mapUser(user).role)) return;
  const active = await ctx.db
    .query("taWorkdays")
    .withIndex("by_user", q => q.eq("userId", user._id))
    .collect();
  const today = active.find(d => d.date === workdayDate(Date.now()) && (d.finishedAt === undefined || d.closureReason === "eod"));
  if (today) {
    if (!today.jobs.some((j) => j.jobId === jobId))
      throw new Error(
        "Add this assigned position to your workday first.",
      );
    return;
  }
  const prior = await ctx.db
    .query("taWorkdays")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .order("desc")
    .first();
  // Existing accounts continue to work until their first explicit Start click.
  if (prior)
    throw new Error("Start your workday before continuing recruitment work.");
}
