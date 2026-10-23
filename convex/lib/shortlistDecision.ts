// convex/lib/shortlistDecision.ts
//
// Every move onto a reviewer's shortlist leaves the reviewer's decision behind
// it, on the review round the candidate was sent in (22 Oct).
//
// Until then only a parsed reply wrote `reviewRounds.decisions`. A lead moving
// somebody to Director Shortlist by hand, a bulk move, or the Director's own
// shortlist mail at shortlists@ moved the stage and recorded nothing, so the
// stage and the decisions drifted apart and nobody could tell which people the
// Director had actually chosen.

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Record a reviewer's decision on the latest round of that kind that carried
 * this application. Returns false when no round did — someone moved without
 * ever being sent, which the decision report lists for a person.
 */
export async function recordShortlistDecision(
  ctx: MutationCtx,
  args: {
    applicationId: Id<"applications">;
    jobId: Id<"jobs">;
    kind: "director" | "client";
    outcome: "shortlisted" | "rejected";
    note: string;
    /** A person decided, rather than a parse of an email. */
    confirmed: boolean;
  },
): Promise<boolean> {
  const rounds = await ctx.db
    .query("reviewRounds")
    .withIndex("by_opening_kind", (q) => q.eq("openingId", args.jobId).eq("kind", args.kind))
    .collect();
  const round = rounds
    .filter((r) => r.applicationIds.includes(args.applicationId))
    .sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!round) return false;
  const prior = round.decisions.find((d) => d.applicationId === args.applicationId);
  if (prior && prior.outcome === args.outcome && (prior.confirmed || !args.confirmed)) return true;
  const decisions = [
    ...round.decisions.filter((d) => d.applicationId !== args.applicationId),
    { applicationId: args.applicationId, outcome: args.outcome, note: args.note.slice(0, 240), confirmed: args.confirmed },
  ];
  await ctx.db.patch(round._id, {
    decisions,
    status: decisions.filter((d) => d.outcome !== "hold").length >= round.applicationIds.length ? "returned" : "partial",
  });
  return true;
}
