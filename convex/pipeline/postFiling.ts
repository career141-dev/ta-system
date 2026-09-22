// convex/pipeline/postFiling.ts
//
// Which job an application email to a shared mailbox (linkedin@, cv@) is for,
// by the TA platform's post rules — and filing the CV onto those posts.
//
// The old routing took the first job whose title appeared anywhere in the
// subject, then asked a model to guess from the email, then from the CV. A
// guess puts a candidate in front of the wrong client, and the applications it
// made carried no post, so no TA ever saw them (visibility.ts shows a TA the
// rows on their own posts). Here the rules in lib/postRouting.ts decide:
// LinkedIn job number, campaign code, then the headline — exact title, an old
// title, or an alias keyword — and nothing else. Same title on two openings
// files to both (Uzmaan-tech's rule of 13 September, confirmed by the owner on
// 22 September); no match leaves the person in the database.
//
// Off unless C141_POST_ROUTING=on, so the old path stays one setting away.

import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import { routeShared } from "../lib/postRouting";

export function postRoutingOn(): boolean {
  return (process.env.C141_POST_ROUTING ?? "").trim().toLowerCase() === "on";
}

export interface EmailRoute {
  jobId?: Id<"jobs">;
  jobPostId?: Id<"jobPosts">;
  /** Other openings the same advert serves — the CV is filed to each. */
  alsoTo: { jobId: Id<"jobs">; jobPostId: Id<"jobPosts"> }[];
  /** One line for the log a person reads. */
  note: string;
}

/** Route one email among every post on an open opening. */
export async function routeByPosts(
  ctx: ActionCtx,
  input: { subject: string; body?: string | null; channel: string },
): Promise<EmailRoute> {
  const posts = await ctx.runQuery(internal.mailIntake.model.livePosts, { includeDraft: true });
  const pick = routeShared(
    { subject: input.subject, body: input.body, linkedinOnly: input.channel === "linkedin" },
    posts,
  );
  if (!pick) {
    return { alsoTo: [], note: `No job post matched "${input.subject.slice(0, 80)}", so the candidate went to the database.` };
  }
  const how =
    pick.how === "linkedin_job" ? "the LinkedIn job link" : pick.how === "linkedin_project" ? "the LinkedIn project in the View applicant link" : pick.how === "campaign_code" ? "the campaign code" : `the ${pick.confidence === "keyword" ? "keyword" : "title"} "${pick.matchedOn}"`;
  const extra = pick.alsoTo.length ? `, and ${pick.alsoTo.length} more opening${pick.alsoTo.length > 1 ? "s" : ""} with the same advert` : "";
  return {
    jobId: pick.openingId as Id<"jobs">,
    jobPostId: pick.postId as Id<"jobPosts">,
    alsoTo: pick.alsoTo.map((a) => ({ jobId: a.openingId as Id<"jobs">, jobPostId: a.postId as Id<"jobPosts"> })),
    note: `Matched by ${how}${extra}.`,
  };
}

/**
 * After a CV has become a candidate on its job: tag that application with its
 * post, and file the candidate to every other opening the advert serves.
 */
export async function filePosts(
  ctx: ActionCtx,
  args: {
    candidateId: Id<"candidates">;
    cvUploadId: Id<"cvUploads">;
    jobId: string;
    sourceChannel: string;
    upload: { assignToJobPost?: string; alsoAssignTo?: { jobId: string; jobPostId: string }[]; metaHeadline?: string } | null;
    score: boolean;
  },
): Promise<void> {
  const upload = args.upload;
  if (!upload) return;
  if (upload.assignToJobPost) {
    await ctx.runMutation(internal.mailIntake.model.setApplicationPost, {
      candidateId: args.candidateId,
      jobId: args.jobId as Id<"jobs">,
      jobPostId: upload.assignToJobPost as Id<"jobPosts">,
    });
  }
  for (const extra of upload.alsoAssignTo ?? []) {
    if (extra.jobId === args.jobId) continue;
    await ctx.runMutation(api.applications.applications.createApplication, {
      candidateId: args.candidateId,
      jobId: extra.jobId as Id<"jobs">,
      cvFileId: args.cvUploadId,
      sourceChannel: args.sourceChannel,
      metaHeadline: upload.metaHeadline,
    });
    await ctx.runMutation(internal.mailIntake.model.setApplicationPost, {
      candidateId: args.candidateId,
      jobId: extra.jobId as Id<"jobs">,
      jobPostId: extra.jobPostId as Id<"jobPosts">,
    });
    if (args.score) {
      await ctx.scheduler.runAfter(0, api.cvs.cvScoringActions.processCvScoring, {
        candidateId: args.candidateId,
        jobId: extra.jobId as Id<"jobs">,
      });
    }
  }
}
