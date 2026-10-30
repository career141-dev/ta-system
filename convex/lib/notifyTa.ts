// convex/lib/notifyTa.ts
//
// A bell notification to the TA looking after a candidate's follow-up.
// Kept apart from the mutation modules so any of them can import it.

import type { Id } from "../_generated/dataModel";

/**
 * Tell the TA looking after this candidate (30 Oct): whoever took the
 * conversation over, else whoever shortlisted them, else the opening's
 * primary recruiter. "Needs you" only showed on the candidate's page, so a
 * candidate who asked for a person waited until someone happened to look.
 */
export async function notifyFollowUpTaFor(ctx: any, applicationId: Id<"applications">, title: string, body: string): Promise<void> {
  const app = await ctx.db.get(applicationId);
  if (!app) return;
  const job = await ctx.db.get(app.jobId);
  const userId = app.taTookOverBy ?? app.ownerTaId ?? job?.primaryRecruiterId;
  if (!userId) return;
  await ctx.db.insert("notifications", {
    userId,
    type: "candidate_replied",
    title: title.slice(0, 200),
    body: body.slice(0, 600),
    jobId: app.jobId,
    read: false,
    createdAt: new Date().toISOString(),
  });
}
