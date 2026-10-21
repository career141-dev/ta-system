import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { activeWorkLocationIds, locationEodComplete } from "../../src/lib/workLocations";

export const acceptedEod = (r: Doc<"taWorkdayMail">) => r.status === "accepted" && !!r.finalizedAt && !r.revised && !r.recoveryReopenedAt && (r.submissionType ?? "eod") === "eod";

export async function workdayLocationIds(ctx: QueryCtx | MutationCtx, entry: Doc<"taWorkdays">["jobs"][number]) {
  return entry.workLocationIds?.length ? entry.workLocationIds : activeWorkLocationIds((await ctx.db.get(entry.jobId)) ?? {});
}

export async function jobEodComplete(ctx: QueryCtx | MutationCtx, entry: Doc<"taWorkdays">["jobs"][number], receipts: Doc<"taWorkdayMail">[]) {
  return locationEodComplete(await workdayLocationIds(ctx, entry), receipts.filter(acceptedEod));
}
