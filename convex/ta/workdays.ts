import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  requireActor,
  assertJobAccess,
  assertNotAnotherTasCandidate,
} from "./guard";
import { mapUser } from "../../src/data/convex/map";
import { expectedSalaryOnFile, noticePeriodOnFile, toTaStage } from "./stages";
import { isGone } from "../../src/lib/bin";
import { workingStageKey } from "../../src/lib/workingStage";
import { colomboDayStart } from "../../src/lib/calendar";
import { assertWorkdayScope } from "../lib/workdayScope";
import {
  applyCarryForwards,
  completionBlockers,
  extraPositionNeedsApproval,
  validateCarry,
  workdayDate,
  type WorkdayCheck,
  type WorkdayJobView,
  type WorkdayView,
  type WorkType,
} from "../../src/lib/workday";

type Ctx = QueryCtx | MutationCtx;
const workType = v.union(
  v.literal("100%"),
  v.literal("Add-on"),
  v.literal("Follow-up"),
);
const recruiters = ["primary_recruiter", "supporting_recruiter"];
const LIMIT = 1200;
const roleOf = (user: Doc<"users">) => mapUser(user).role;
const canLead = (user: Doc<"users">) =>
  ["admin", "ta_lead"].includes(roleOf(user));

function requireWorker(user: Doc<"users">) {
  if (!["ta", "ta_support"].includes(roleOf(user)))
    throw new Error("Workdays are for TAs and TA support.");
}

async function activeFor(ctx: Ctx, userId: Id<"users">) {
  return ctx.db
    .query("taWorkdays")
    .withIndex("by_user_finished", (q) =>
      q.eq("userId", userId).eq("finishedAt", undefined),
    )
    .first();
}

async function ownedActive(ctx: Ctx, user: Doc<"users">, id: Id<"taWorkdays">) {
  const day = await ctx.db.get(id);
  if (!day || day.userId !== user._id)
    throw new Error("That workday is not yours.");
  if (day.finishedAt !== undefined)
    throw new Error("That workday is already finished.");
  return day;
}

async function assignedJob(ctx: Ctx, user: Doc<"users">, id: Id<"jobs">) {
  await assertJobAccess(ctx, user, id, recruiters);
  const job = await ctx.db.get(id);
  if (!job || isGone(job)) throw new Error("That job is no longer available.");
  if (!job.taLeadId)
    throw new Error(
      "Ask the lead to assign a TA Lead to this job before starting work.",
    );
  return job;
}

async function setMode(
  ctx: MutationCtx,
  userId: Id<"users">,
  jobId: Id<"jobs">,
  stage: WorkType,
) {
  const assignment = await ctx.db
    .query("jobAssignments")
    .withIndex("by_jobId_userId", (q) =>
      q.eq("jobId", jobId).eq("userId", userId),
    )
    .filter((q) => q.eq(q.field("isActive"), true))
    .first();
  if (assignment) await ctx.db.patch(assignment._id, { workingStage: stage });
  else {
    const key = workingStageKey(jobId, userId);
    const row = await ctx.db
      .query("taSettings")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (row)
      await ctx.db.patch(row._id, { value: stage, updatedAt: Date.now() });
    else
      await ctx.db.insert("taSettings", {
        key,
        value: stage,
        updatedAt: Date.now(),
      });
  }
}

/** Keep the existing opening menu and the daily mode history in agreement. */
export async function recordActiveMode(
  ctx: MutationCtx,
  userId: Id<"users">,
  jobId: Id<"jobs">,
  stage: WorkType,
) {
  const day = await activeFor(ctx, userId);
  const entry = day?.jobs.find((j) => j.jobId === jobId);
  if (!day || !entry || entry.workType === stage) return;
  await ctx.db.patch(day._id, {
    jobs: day.jobs.map((j) =>
      j.jobId === jobId
        ? {
            ...j,
            workType: stage,
            modeHistory: [
              ...j.modeHistory,
              { at: Date.now(), workType: stage },
            ],
          }
        : j,
    ),
  });
}

async function notify(
  ctx: MutationCtx,
  leadId: Id<"users"> | undefined,
  user: Doc<"users">,
  jobId: Id<"jobs">,
  type:
    | "workday_started"
    | "workday_finished"
    | "workday_request"
    | "workday_decision",
  title: string,
) {
  if (!leadId) return;
  await ctx.db.insert("notifications", {
    userId: leadId,
    jobId,
    type,
    title,
    body: `${user.fullName} · ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Colombo" })}`,
    read: false,
    createdAt: new Date().toISOString(),
  });
}

async function attachLead(
  ctx: MutationCtx,
  workdayId: Id<"taWorkdays">,
  leadId: Id<"users"> | undefined,
) {
  if (!leadId) return;
  const existing = await ctx.db
    .query("taWorkdayLeads")
    .withIndex("by_workday", (q) => q.eq("workdayId", workdayId))
    .collect();
  if (!existing.some((r) => r.leadId === leadId))
    await ctx.db.insert("taWorkdayLeads", { workdayId, leadId });
}

async function jobView(
  ctx: Ctx,
  day: Doc<"taWorkdays">,
  entry: Doc<"taWorkdays">["jobs"][number],
  now: number,
): Promise<WorkdayJobView> {
  const job = await ctx.db.get(entry.jobId);
  const base = `/openings/${entry.jobId}`;
  const checks: WorkdayCheck[] = [];
  const add = (
    key: string,
    label: string,
    kind: WorkdayCheck["kind"],
    href: string,
    canCarry = false,
    evidenceAt = 0,
  ) =>
    checks.push({
      key,
      jobId: entry.jobId,
      label,
      kind,
      href,
      canCarry,
      evidenceAt,
    });
  const since = colomboDayStart(day.startedAt);
  const appQueues = await Promise.all([
    ctx.db
      .query("applications")
      .withIndex("by_job_stage_reviewed", (q) =>
        q
          .eq("jobId", entry.jobId)
          .eq("currentStage", "new_cvs")
          .eq("workdayReviewedAt", undefined),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("applications")
      .withIndex("by_jobId", (q) =>
        q.eq("jobId", entry.jobId).gte("_creationTime", since),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("applications")
      .withIndex("by_workday_owner", (q) =>
        q.eq("jobId", entry.jobId).eq("ownerTaId", day.userId),
      )
      .filter((q) =>
        q.or(
          ...["follow_up", "ta_shortlist", "ai_call", "second_shortlist"].map(
            (stage) => q.eq(q.field("currentStage"), stage),
          ),
        ),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("applications")
      .withIndex("by_workday_owner", (q) =>
        q
          .eq("jobId", entry.jobId)
          .eq("ownerTaId", day.userId)
          .gte("shortlistedAt", day.startedAt),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("applications")
      .withIndex("by_workday_review", (q) =>
        q.eq("jobId", entry.jobId).gte("workdayReviewedAt", day.startedAt),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("applications")
      .withIndex("by_workday_reapply", (q) =>
        q.eq("jobId", entry.jobId).gte("reappliedAt", since),
      )
      .take(LIMIT + 1),
  ]);
  const apps = [...new Map(appQueues.flat().map((a) => [a._id, a])).values()];
  const linkQueues = await Promise.all([
    ctx.db
      .query("linkVault")
      .withIndex("by_workday_added", (q) =>
        q
          .eq("openingId", entry.jobId)
          .eq("addedBy", day.userId)
          .gte("createdAt", day.startedAt),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("linkVault")
      .withIndex("by_workday_outcome", (q) =>
        q
          .eq("openingId", entry.jobId)
          .eq("addedBy", day.userId)
          .eq("outcome", "shortlisted"),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("linkVault")
      .withIndex("by_workday_outcome", (q) =>
        q
          .eq("openingId", entry.jobId)
          .eq("addedBy", day.userId)
          .eq("outcome", "cv_received"),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("linkVault")
      .withIndex("by_opening", (q) => q.eq("openingId", entry.jobId))
      .filter((q) =>
        q.and(
          q.eq(q.field("addedBy"), day.userId),
          q.gte(q.field("outcomeAt"), day.startedAt),
        ),
      )
      .take(LIMIT + 1),
  ]);
  const links = [...new Map(linkQueues.flat().map((l) => [l._id, l])).values()];
  // One mailbox upload can be routed to several adverts. Its secondary jobs
  // must see pending extraction too, before application rows exist.
  const secondaryQueues = await Promise.all(
    [
      "uploaded",
      "queued",
      "pending",
      "processing",
      "pending_retry",
      "failed",
      "needs_review",
      "healing",
    ].map((status) =>
      ctx.db
        .query("cvUploads")
        .withIndex("by_status", (q) =>
          q.eq("status", status).gte("_creationTime", since),
        )
        .filter((q) => q.neq(q.field("alsoAssignTo"), undefined))
        .take(LIMIT + 1),
    ),
  );
  const [
    rounds,
    research,
    benchmarks,
    posts,
    carries,
    uploads,
    receipts,
    activity,
  ] = await Promise.all([
    ctx.db
      .query("reviewRounds")
      .withIndex("by_opening", (q) => q.eq("openingId", entry.jobId))
      .take(LIMIT + 1),
    ctx.db
      .query("researchReports")
      .withIndex("by_opening", (q) => q.eq("openingId", entry.jobId))
      .first(),
    ctx.db
      .query("benchmarks")
      .withIndex("by_opening", (q) => q.eq("openingId", entry.jobId))
      .take(LIMIT + 1),
    ctx.db
      .query("jobPosts")
      .withIndex("by_opening", (q) => q.eq("openingId", entry.jobId))
      .take(LIMIT + 1),
    ctx.db
      .query("taWorkdayCarry")
      .withIndex("by_user_job", (q) =>
        q.eq("userId", day.userId).eq("jobId", entry.jobId),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("cvUploads")
      .withIndex("by_assignToJob", (q) => q.eq("assignToJob", entry.jobId))
      .take(LIMIT + 1),
    ctx.db
      .query("taWorkdayMail")
      .withIndex("by_workday_job", (q) =>
        q.eq("workdayId", day._id).eq("jobId", entry.jobId),
      )
      .take(LIMIT + 1),
    ctx.db
      .query("taWorkdayActivity")
      .withIndex("by_workday_job", (q) =>
        q.eq("workdayId", day._id).eq("jobId", entry.jobId),
      )
      .take(LIMIT + 1),
  ]);
  // Never close from a truncated queue; surface the limit instead of omitting CVs.
  if (
    [
      ...appQueues,
      ...secondaryQueues,
      ...linkQueues,
      rounds,
      benchmarks,
      posts,
      carries,
      uploads,
      receipts,
      activity,
    ].some((rows) => rows.length > LIMIT)
  )
    add(
      "capacity",
      "This job needs a lead review: its work queue exceeds the checklist limit.",
      "system",
      base,
    );
  if (!job || isGone(job))
    add(
      "job_access",
      "This job is no longer available. Ask the TA Lead to resolve the workday.",
      "system",
      "/workday",
    );
  const accepted = rounds.filter(
    (r) => r.kind === "director" && r.dispatch === "sent",
  );
  // Historical rounds are the roster the existing composer already excludes.
  // Today's completion still requires a confirmed transport acknowledgement.
  const sentIds = new Set(
    rounds
      .filter(
        (r) =>
          r.kind === "director" &&
          (r.dispatch === "sent" || r.sentAt < day.startedAt),
      )
      .flatMap((r) => r.applicationIds as string[]),
  );
  for (const receipt of receipts.filter(
    (r) => r.status === "accepted" && r.finalizedAt,
  ))
    for (const id of receipt.applicationIds) sentIds.add(id);
  const today = accepted.filter(
    (r) => r.sentBy === day.userId && r.sentAt >= day.startedAt,
  );
  const completedReceipts = receipts.filter(
    (r) => r.status === "accepted" && r.finalizedAt,
  );
  for (const receipt of receipts.filter(
    (r) =>
      ["sending", "uncertain"].includes(r.status) ||
      (r.status === "accepted" && !r.finalizedAt),
  ))
    add(
      `mail:${receipt._id}`,
      "An email is still sending or its result needs reconciliation. Do not send it again.",
      "system",
      `${base}/eod`,
    );
  const minePosts = new Set(
    posts
      .filter((p) => p.assignedTaId === day.userId)
      .map((p) => p._id as string),
  );
  let reviews = 0;
  const shortlist: WorkdayJobView["shortlist"] = [];
  for (const app of apps) {
    const stage = toTaStage(app.currentStage);
    const mine = app.ownerTaId === day.userId;
    const accessible =
      mine ||
      (!app.ownerTaId && !!app.jobPostId && minePosts.has(app.jobPostId));
    const arrival = Math.max(
      typeof app.createdAt === "number"
        ? app.createdAt
        : Date.parse(app.createdAt) || app._creationTime,
      app.reappliedAt ?? 0,
    );
    const reviewAt = Math.max(
      app.workdayReviewedAt ?? 0,
      app.shortlistedAt ?? 0,
      app.taShortlistById ? (app.taShortlistAt ?? 0) : 0,
      app.rejectedBy && app.rejectedBy !== "system" ? (app.rejectedAt ?? 0) : 0,
    );
    if (
      reviewAt >= day.startedAt &&
      (app.workdayReviewedBy === day.userId ||
        app.ownerTaId === day.userId ||
        app.taShortlistById === day.userId ||
        app.rejectedBy === day.userId)
    )
      reviews++;
    // Database matches are prospects, not CV arrivals. Reapplications must be reviewed again.
    const isIncoming =
      app.currentStage === "new_cvs" ||
      (app.reappliedAt ?? 0) >= since ||
      (!/database/i.test(app.sourceChannel) && arrival >= since);
    if (isIncoming && reviewAt < arrival)
      add(
        `review:${app._id}`,
        accessible
          ? `${app.candidateName ?? "Candidate"}: CV needs a recorded review`
          : "A new CV on this job needs its assigned TA's review",
        "cv_review",
        accessible ? `${base}/pipeline/${stage}` : base,
      );
    if (!mine) continue;
    const candidate = await ctx.db.get(app.candidateId);
    const name = candidate?.fullName ?? app.candidateName ?? "Candidate";
    if (!candidate && !["rejected", "dropped_out", "placed"].includes(stage))
      add(
        `candidate:${app._id}`,
        `${name}: candidate record is missing; ask the lead to recover it`,
        "system",
        base,
      );
    if (
      app.shortlistedAt &&
      (app.shortlistedAt >= day.startedAt ||
        ["ta_follow_up", "ai_follow_up", "director_review"].includes(stage))
    )
      shortlist.push({
        id: app._id,
        name,
        stage,
        source: app.taSourcingChannel ?? app.sourceChannel,
        shortlistedAt: app.shortlistedAt,
        sent: sentIds.has(app._id),
      });
    if (["ta_follow_up", "ai_follow_up"].includes(stage) && candidate) {
      const missing: string[] = [];
      if (!(
        app.followUpCvReceived === true ||
        (app.followUpCvReceived === undefined &&
          (!!candidate.cvUploadId || !!app.cvFileId))
      ))
        missing.push("CV");
      if (!(
        app.followUpExpectedSalary === true ||
        (app.followUpExpectedSalary === undefined &&
          expectedSalaryOnFile(candidate))
      ))
        missing.push("expected salary");
      if (!(
        app.followUpNoticePeriod === true ||
        (app.followUpNoticePeriod === undefined &&
          noticePeriodOnFile(candidate))
      ))
        missing.push("notice period");
      const evidenceAt = Math.max(
        app.lastStageChangedAt,
        app.lastCandidateReplyAt ?? 0,
        app.followUpLastManualSendAt ?? 0,
        app.workdayReviewedAt ?? 0,
      );
      const contacted = !!(
        app.followUpLastManualSendAt ||
        app.followUpAttemptCount ||
        app.lastCandidateReplyAt
      );
      if (missing.length)
        add(
          `details:${app._id}:${missing.join("|")}`,
          `${name}: missing ${missing.join(", ")}`,
          "details",
          `${base}/pipeline/${stage}`,
          contacted,
          evidenceAt,
        );
      else
        add(
          `handoff:${app._id}`,
          `${name}: ready for Director Review`,
          "handoff",
          `${base}/pipeline/${stage}`,
        );
      if (app.nextFollowUpScheduledAt && app.nextFollowUpScheduledAt <= now)
        add(
          `followup:${app._id}`,
          `${name}: follow-up is due`,
          "follow_up",
          `${base}/pipeline/${stage}`,
          true,
          evidenceAt,
        );
    }
    if (stage === "director_review" && !sentIds.has(app._id))
      add(
        `email:${app._id}`,
        `${name}: ready but not included in a sent email`,
        "email",
        `${base}/eod`,
      );
  }
  const myLinks = links.filter((l) => l.addedBy === day.userId);
  for (const carry of carries.filter((c) => c.key.startsWith("profile:"))) {
    const id = ctx.db.normalizeId("linkVault", carry.key.slice(8));
    const link = id ? await ctx.db.get(id) : null;
    if (
      link &&
      link.openingId === entry.jobId &&
      link.addedBy === day.userId &&
      !myLinks.some((l) => l._id === link._id)
    )
      myLinks.push(link);
  }
  const workedLinks = myLinks.filter(
    (l) =>
      l.createdAt >= day.startedAt ||
      (l.outcomeAt ?? 0) >= day.startedAt ||
      l.conversationLog.some(
        (a) => a.by === day.userId && a.at >= day.startedAt,
      ),
  );
  for (const link of myLinks) {
    const linkedApp = link.candidateId
      ? await ctx.db
          .query("applications")
          .withIndex("by_candidate_job", (q) =>
            q.eq("candidateId", link.candidateId!).eq("jobId", entry.jobId),
          )
          .first()
      : null;
    const hasApp = !!linkedApp;
    if (
      link.outcome === "shortlisted" &&
      linkedApp &&
      ["new_cvs", "matched_candidates"].includes(linkedApp.currentStage)
    ) {
      add(
        `profile:${link._id}`,
        `${link.name ?? "LinkedIn profile"}: linked CV still needs shortlisting and Director Review`,
        "profile",
        `${base}/hh/links`,
      );
      continue;
    }
    if (
      link.outcome === "shortlisted" &&
      linkedApp &&
      ["rejected", "unresponsive"].includes(linkedApp.currentStage) &&
      (link.outcomeAt ?? link.createdAt) > linkedApp.lastStageChangedAt
    ) {
      add(
        `profile:${link._id}`,
        `${link.name ?? "LinkedIn profile"}: newly selected profile is closed in the pipeline; recheck the decision`,
        "profile",
        `${base}/hh/links`,
      );
      continue;
    }
    if (["shortlisted", "cv_received"].includes(link.outcome) && !hasApp)
      add(
        `profile:${link._id}`,
        `${link.name ?? "LinkedIn profile"}: suitable profile needs a pipeline handoff`,
        "profile",
        `${base}/hh/links`,
        link.conversationLog.length > 0,
        Math.max(
          link.outcomeAt ?? link.createdAt,
          ...link.conversationLog.map((l) => l.at),
        ),
      );
    else if (
      link.outcome === "no_contact" &&
      (workedLinks.includes(link) ||
        carries.some((c) => c.key === `profile:${link._id}`))
    )
      add(
        `profile:${link._id}`,
        `${link.name ?? "LinkedIn profile"}: record a decision or next action`,
        "profile",
        `${base}/hh/links`,
        true,
        link.outcomeAt ?? link.createdAt,
      );
  }
  for (const upload of uploads) {
    if (
      !["completed", "extracted", "processed", "duplicate"].includes(
        upload.status,
      ) &&
      upload._creationTime >= since &&
      !upload.shortlistCopy &&
      !upload.replacedByUploadId
    )
      add(
        `upload:${upload._id}`,
        "A CV is still processing or needs recovery",
        "system",
        base,
      );
    if (
      ["completed", "processed"].includes(upload.status) &&
      upload._creationTime >= since &&
      upload.candidateId &&
      !upload.shortlistCopy &&
      !upload.replacedByUploadId &&
      !apps.some((a) => a.candidateId === upload.candidateId)
    )
      add(
        `upload:${upload._id}`,
        "A processed CV has not been filed on this job yet",
        "system",
        base,
      );
  }
  for (const upload of secondaryQueues
    .flat()
    .filter(
      (u) =>
        u.assignToJob !== entry.jobId &&
        u.alsoAssignTo?.some((route) => route.jobId === entry.jobId),
    )) {
    if (!upload.shortlistCopy && !upload.replacedByUploadId)
      add(
        `upload:${upload._id}`,
        "A CV routed to this job is still processing or needs recovery",
        "system",
        base,
      );
  }
  if (!today.length && !completedReceipts.length)
    add(
      `daily_email:${entry.jobId}`,
      "Send this job's end-of-day email (activity summary if no candidates are ready)",
      "email",
      `${base}/eod`,
    );
  return {
    jobId: entry.jobId,
    title: job?.title ?? "Unavailable job",
    workType: entry.workType,
    checks: applyCarryForwards(checks, carries, now),
    shortlist,
    activity: {
      cvReviews: reviews,
      profilesAdded: myLinks.filter((l) => l.createdAt >= day.startedAt).length,
      profilesWorked: workedLinks.length,
      researchAt: research?.generatedAt ?? null,
      benchmarks: benchmarks.length,
      benchmarksAdded: benchmarks.filter((b) => b.generatedAt >= day.startedAt)
        .length,
      researchActions: activity.filter((a) =>
        a.kind.startsWith("researchReports:"),
      ).length,
      benchmarkActions: activity.filter((a) => a.kind.startsWith("benchmarks:"))
        .length,
      jdApproved: job?.jdStatus === "approved",
      postConnected: posts.some(
        (p) => p.channel.toLowerCase().includes("linkedin") && !!p.externalUrl,
      ),
      sent: new Set([
        ...today.flatMap((r) => r.applicationIds),
        ...completedReceipts.flatMap((r) => r.applicationIds),
      ]).size,
      emailAt:
        today.length || completedReceipts.length
          ? Math.max(
              ...today.map((r) => r.sentAt),
              ...completedReceipts.map((r) => r.acceptedAt ?? r.startedAt),
            )
          : null,
    },
  };
}

async function view(
  ctx: Ctx,
  day: Doc<"taWorkdays">,
  now: number,
): Promise<WorkdayView> {
  if (day.finishedAt !== undefined && day.completion)
    return day.completion as WorkdayView;
  const user = await ctx.db.get(day.userId);
  const requests = await ctx.db
    .query("taWorkdayRequests")
    .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
    .collect();
  return {
    id: day._id,
    userId: day.userId,
    name: user?.fullName ?? "Unavailable user",
    date: day.date,
    startedAt: day.startedAt,
    finishedAt: day.finishedAt ?? null,
    jobs: await Promise.all(day.jobs.map((j) => jobView(ctx, day, j, now))),
    requests: await Promise.all(
      requests.map(async (r) => ({
        id: r._id,
        jobId: r.jobId,
        title: (await ctx.db.get(r.jobId))?.title ?? "Unavailable job",
        status: r.status,
        reason: r.reason,
      })),
    ),
  };
}

export const dashboard = internalQuery({
  args: { actorId: v.string(), detail: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const role = roleOf(user);
    const worker = ["ta", "ta_support"].includes(role);
    const lead = canLead(user);
    if (!worker && !lead) throw new Error("You cannot access workdays.");
    const now = Date.now();
    const active = worker ? await activeFor(ctx, user._id) : null;
    const latest = worker
      ? await ctx.db
          .query("taWorkdays")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .order("desc")
          .first()
      : null;
    const lastFinishedAt = latest?.finishedAt ?? null;
    const lastFinishedDate =
      latest?.finishedAt !== undefined ? (latest?.date ?? null) : null;
    if (!args.detail)
      return {
        canWork: worker,
        canLead: lead,
        role,
        lastFinishedAt,
        lastFinishedDate,
        active: active ? await view(ctx, active, now) : null,
        history: [],
        team: [],
        options: [],
      };
    const assignments = await ctx.db
      .query("jobAssignments")
      .withIndex("by_userId_isActive", (q) =>
        q.eq("userId", user._id).eq("isActive", true),
      )
      .collect();
    const listed = await ctx.db.query("jobs").take(1000);
    const assignedIds = new Set(
      assignments
        .filter((a) => recruiters.includes(a.assignmentRole))
        .map((a) => a.jobId as string),
    );
    const options = worker
      ? listed
          .filter(
            (j) =>
              !isGone(j) &&
              (assignedIds.has(j._id) || j.assignedTaIds?.includes(user._id)),
          )
          .map((j) => ({ id: j._id, title: j.title }))
      : [];
    const history = worker
      ? await ctx.db
          .query("taWorkdays")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .order("desc")
          .take(15)
      : [];
    let recent: Doc<"taWorkdays">[] = [];
    if (lead) {
      if (role === "admin") {
        const [working, history] = await Promise.all([
          ctx.db
            .query("taWorkdays")
            .withIndex("by_finished", (q) => q.eq("finishedAt", undefined))
            .take(100),
          ctx.db.query("taWorkdays").order("desc").take(50),
        ]);
        recent = [
          ...new Map([...working, ...history].map((d) => [d._id, d])).values(),
        ];
      } else {
        const [working, history] = await Promise.all([
          ctx.db
            .query("taWorkdayLeads")
            .withIndex("by_lead_finished", (q) =>
              q.eq("leadId", user._id).eq("finishedAt", undefined),
            )
            .take(100),
          ctx.db
            .query("taWorkdayLeads")
            .withIndex("by_lead", (q) => q.eq("leadId", user._id))
            .order("desc")
            .take(50),
        ]);
        const ids = [
          ...new Set([...working, ...history].map((d) => d.workdayId)),
        ];
        recent = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
          (d): d is Doc<"taWorkdays"> => !!d,
        );
      }
    }
    const team: WorkdayView[] = [];
    for (const day of recent) {
      const visibleJobs =
        role === "admin"
          ? day.jobs
          : day.jobs.filter((j) => j.leadId === user._id);
      const requests = await ctx.db
        .query("taWorkdayRequests")
        .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
        .collect();
      const visibleRequests =
        role === "admin"
          ? requests
          : requests.filter((r) => r.leadId === user._id);
      if (!visibleJobs.length && !visibleRequests.length) continue;
      // Build only the lead's jobs: a second job may belong to another team.
      const scoped = { ...day, jobs: visibleJobs, completion: undefined };
      const result =
        day.finishedAt !== undefined && day.completion
          ? {
              ...(day.completion as WorkdayView),
              jobs: (day.completion as WorkdayView).jobs.filter((j) =>
                visibleJobs.some((v) => v.jobId === j.jobId),
              ),
            }
          : await view(ctx, scoped, now);
      result.requests = result.requests.filter((r) =>
        visibleRequests.some((v) => v._id === r.id),
      );
      team.push(result);
    }
    return {
      canWork: worker,
      canLead: lead,
      role,
      lastFinishedAt,
      lastFinishedDate,
      active: active ? await view(ctx, active, now) : null,
      history: await Promise.all(
        history
          .filter((d) => d.finishedAt !== undefined)
          .map((d) => view(ctx, d, now)),
      ),
      team,
      options,
    };
  },
});

export const checkScope = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    await assertWorkdayScope(ctx, user, args.jobId);
    return { ok: true };
  },
});

/** Reserve before Graph is called; a lost response must not trigger a second send. */
export const beginMail = internalMutation({
  args: {
    actorId: v.string(),
    jobId: v.id("jobs"),
    applicationIds: v.array(v.id("applications")),
    subject: v.string(),
    sentTo: v.string(),
    researchLink: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const day = await activeFor(ctx, user._id);
    if (!day || !day.jobs.some((j) => j.jobId === args.jobId))
      return { id: null };
    await assignedJob(ctx, user, args.jobId);
    const previous = await ctx.db
      .query("taWorkdayMail")
      .withIndex("by_workday_job", (q) =>
        q.eq("workdayId", day._id).eq("jobId", args.jobId),
      )
      .collect();
    if (
      previous.some(
        (r) =>
          r.status === "sending" ||
          r.status === "uncertain" ||
          (r.status === "accepted" && !r.finalizedAt),
      )
    )
      throw new Error(
        "This job has a send in progress or an uncertain result. Ask the lead to reconcile it before retrying.",
      );
    const sent = new Set(
      previous
        .filter((r) => r.status === "accepted")
        .flatMap((r) => r.applicationIds as string[]),
    );
    if (args.applicationIds.some((id) => sent.has(id)))
      throw new Error(
        "These candidates have already been sent in this workday.",
      );
    if (
      !args.applicationIds.length &&
      previous.some((r) => r.status === "accepted" && !r.applicationIds.length)
    )
      throw new Error(
        "This workday's activity email has already been sent for the job.",
      );
    for (const id of args.applicationIds) {
      const app = await ctx.db.get(id);
      if (
        !app ||
        app.jobId !== args.jobId ||
        app.ownerTaId !== user._id ||
        app.currentStage !== "second_shortlist"
      )
        throw new Error(
          "Send only your candidates who are in Director Review.",
        );
    }
    const id = await ctx.db.insert("taWorkdayMail", {
      workdayId: day._id,
      userId: user._id,
      jobId: args.jobId,
      applicationIds: args.applicationIds,
      status: "sending",
      startedAt: Date.now(),
      subject: args.subject,
      sentTo: args.sentTo,
      researchLink: args.researchLink,
    });
    return { id };
  },
});

/** Internal transport acknowledgement, never a browser-controlled success flag. */
export const mailResult = internalMutation({
  args: {
    id: v.id("taWorkdayMail"),
    status: v.union(
      v.literal("accepted"),
      v.literal("failed"),
      v.literal("uncertain"),
    ),
  },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.id);
    if (!receipt || receipt.status !== "sending") return;
    await ctx.db.patch(receipt._id, {
      status: args.status,
      ...(args.status === "accepted" ? { acceptedAt: Date.now() } : {}),
    });
  },
});

export const finalizeMail = internalMutation({
  args: { actorId: v.string(), id: v.id("taWorkdayMail") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const receipt = await ctx.db.get(args.id);
    if (
      !receipt ||
      receipt.userId !== user._id ||
      receipt.status !== "accepted"
    )
      throw new Error("The email was not confirmed as accepted for sending.");
    await ctx.db.patch(receipt._id, { finalizedAt: Date.now() });
  },
});

export const reconcileMail = internalMutation({
  args: {
    actorId: v.string(),
    id: v.id("taWorkdayMail"),
    accepted: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const lead = await requireActor(ctx, args.actorId);
    const receipt = await ctx.db.get(args.id);
    const day = receipt ? await ctx.db.get(receipt.workdayId) : null;
    const entry = day?.jobs.find((j) => j.jobId === receipt?.jobId);
    if (
      !receipt ||
      !day ||
      !entry ||
      !canLead(lead) ||
      (roleOf(lead) !== "admin" && entry.leadId !== lead._id)
    )
      throw new Error("Only this job's TA Lead can reconcile its email.");
    if (day.finishedAt !== undefined || receipt.finalizedAt)
      throw new Error("This send has already been resolved.");
    if (!args.reason.trim() || args.reason.length > 1000)
      throw new Error(
        "Record how you verified the mailbox result, including the message reference if sent.",
      );
    if (
      receipt.status === "sending" &&
      Date.now() - receipt.startedAt < 5 * 60000
    )
      throw new Error(
        "The send may still be running. Wait at least five minutes and verify the mailbox before reconciling.",
      );
    if (receipt.status === "accepted" && !args.accepted)
      throw new Error(
        "Microsoft Graph already accepted this email. Its submission record needs recovery.",
      );
    const now = Date.now();
    if (args.accepted) {
      const rounds = await ctx.db
        .query("reviewRounds")
        .withIndex("by_opening", (q) => q.eq("openingId", receipt.jobId))
        .collect();
      const exists = rounds.some(
        (r) =>
          r.sentBy === receipt.userId &&
          r.sentAt >= receipt.startedAt &&
          r.dispatch === "sent" &&
          r.applicationIds.length === receipt.applicationIds.length &&
          receipt.applicationIds.every((id) => r.applicationIds.includes(id)),
      );
      if (!exists)
        await ctx.db.insert("reviewRounds", {
          openingId: receipt.jobId,
          kind: "director",
          token: `C141-WD-${receipt._id.slice(-8)}`,
          applicationIds: receipt.applicationIds,
          sentBy: receipt.userId,
          sentAt: receipt.acceptedAt ?? receipt.startedAt,
          sentTo: receipt.sentTo,
          subject: receipt.subject,
          researchLink: receipt.researchLink,
          dispatch: "sent",
          status: receipt.applicationIds.length ? "awaiting" : "returned",
          decisions: [],
        });
    }
    await ctx.db.patch(receipt._id, {
      status: args.accepted ? "accepted" : "failed",
      acceptedAt: args.accepted ? (receipt.acceptedAt ?? now) : undefined,
      finalizedAt: args.accepted ? now : undefined,
      reconciledAt: now,
      reconciledBy: lead._id,
      reconciliationReason: args.reason.trim(),
    });
    return { ok: true };
  },
});

export const start = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), workType },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    const active = await activeFor(ctx, user._id);
    if (active) return { id: active._id };
    const prior = await ctx.db
      .query("taWorkdays")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    if (prior?.date === workdayDate(Date.now()))
      throw new Error(
        "Today's workday is already finished. Ask the lead to review its record.",
      );
    const job = await assignedJob(ctx, user, args.jobId);
    const now = Date.now();
    const id = await ctx.db.insert("taWorkdays", {
      userId: user._id,
      date: workdayDate(now),
      startedAt: now,
      jobs: [
        {
          jobId: args.jobId,
          workType: args.workType,
          addedAt: now,
          leadId: job.taLeadId,
          modeHistory: [{ at: now, workType: args.workType }],
        },
      ],
    });
    await setMode(ctx, user._id, args.jobId, args.workType);
    await attachLead(ctx, id, job.taLeadId);
    await notify(
      ctx,
      job.taLeadId,
      user,
      args.jobId,
      "workday_started",
      "Started workday",
    );
    return { id };
  },
});

export const addPosition = internalMutation({
  args: {
    actorId: v.string(),
    workdayId: v.id("taWorkdays"),
    jobId: v.id("jobs"),
    workType,
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    const day = await ownedActive(ctx, user, args.workdayId);
    if (day.jobs.some((j) => j.jobId === args.jobId)) return { pending: false };
    if (day.jobs.length >= 10)
      throw new Error("A workday supports at most ten positions.");
    const job = await assignedJob(ctx, user, args.jobId);
    if (extraPositionNeedsApproval(roleOf(user), day.jobs.length)) {
      if (!job.taLeadId)
        throw new Error(
          "This position needs a TA Lead before approval can be requested.",
        );
      const requests = await ctx.db
        .query("taWorkdayRequests")
        .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
        .collect();
      if (requests.some((r) => r.jobId === args.jobId))
        return { pending: true };
      await ctx.db.insert("taWorkdayRequests", {
        userId: user._id,
        workdayId: day._id,
        jobId: args.jobId,
        leadId: job.taLeadId,
        workType: args.workType,
        status: "pending",
        requestedAt: Date.now(),
      });
      await attachLead(ctx, day._id, job.taLeadId);
      await notify(
        ctx,
        job.taLeadId,
        user,
        job._id,
        "workday_request",
        "Second-position approval requested",
      );
      return { pending: true };
    }
    const now = Date.now();
    await ctx.db.patch(day._id, {
      jobs: [
        ...day.jobs,
        {
          jobId: job._id,
          workType: args.workType,
          addedAt: now,
          leadId: job.taLeadId,
          modeHistory: [{ at: now, workType: args.workType }],
        },
      ],
    });
    await setMode(ctx, user._id, job._id, args.workType);
    await attachLead(ctx, day._id, job.taLeadId);
    await notify(
      ctx,
      job.taLeadId,
      user,
      job._id,
      "workday_started",
      "Started work on another position",
    );
    return { pending: false };
  },
});

export const decide = internalMutation({
  args: {
    actorId: v.string(),
    requestId: v.id("taWorkdayRequests"),
    approve: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const lead = await requireActor(ctx, args.actorId);
    const request = await ctx.db.get(args.requestId);
    if (
      !request ||
      !canLead(lead) ||
      (roleOf(lead) !== "admin" && request.leadId !== lead._id)
    )
      throw new Error("Only this position's TA Lead can decide.");
    if (request.status !== "pending") return { ok: true };
    if (!args.reason.trim() || args.reason.length > 1000)
      throw new Error("Give a short decision reason.");
    const user = await ctx.db.get(request.userId);
    if (!user?.isActive) throw new Error("That TA is no longer active.");
    const day = await ownedActive(ctx, user, request.workdayId);
    const job = await assignedJob(ctx, user, request.jobId);
    const now = Date.now();
    if (args.approve) {
      if (day.jobs.length >= 10)
        throw new Error("The workday already has ten positions.");
      if (!day.jobs.some((j) => j.jobId === job._id))
        await ctx.db.patch(day._id, {
          jobs: [
            ...day.jobs,
            {
              jobId: job._id,
              workType: request.workType,
              addedAt: now,
              leadId: job.taLeadId,
              modeHistory: [{ at: now, workType: request.workType }],
            },
          ],
        });
      await setMode(ctx, user._id, job._id, request.workType);
      await attachLead(ctx, day._id, job.taLeadId);
    }
    await ctx.db.patch(request._id, {
      status: args.approve ? "approved" : "denied",
      decidedAt: now,
      decidedBy: lead._id,
      reason: args.reason.trim(),
    });
    await notify(
      ctx,
      user._id,
      lead,
      job._id,
      "workday_decision",
      args.approve ? "Second position approved" : "Second position declined",
    );
    return { ok: true };
  },
});

export const markReviewed = internalMutation({
  args: {
    actorId: v.string(),
    workdayId: v.id("taWorkdays"),
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const lead = canLead(user);
    if (!lead) requireWorker(user);
    const day = lead
      ? await ctx.db.get(args.workdayId)
      : await ownedActive(ctx, user, args.workdayId);
    const app = await ctx.db.get(args.applicationId);
    if (
      !day ||
      day.finishedAt !== undefined ||
      !app ||
      !day.jobs.some((j) => j.jobId === app.jobId)
    )
      throw new Error("This CV is not on an active workday.");
    if (
      lead &&
      roleOf(user) !== "admin" &&
      !day.jobs.some((j) => j.jobId === app.jobId && j.leadId === user._id)
    )
      throw new Error("Only this job's TA Lead can record its review.");
    if (!lead) {
      await assignedJob(ctx, user, app.jobId);
      assertNotAnotherTasCandidate(user, app);
    }
    const post = app.jobPostId ? await ctx.db.get(app.jobPostId) : null;
    if (!lead && app.ownerTaId !== user._id && post?.assignedTaId !== user._id)
      throw new Error("Ask this CV's assigned TA to record the review.");
    if (
      (app.workdayReviewedAt ?? 0) >= (app.reappliedAt ?? 0) &&
      app.workdayReviewedAt
    )
      return { ok: true };
    await ctx.db.patch(app._id, {
      workdayReviewedAt: Date.now(),
      workdayReviewedBy: user._id,
    });
    return { ok: true };
  },
});

export const carry = internalMutation({
  args: {
    actorId: v.string(),
    workdayId: v.id("taWorkdays"),
    jobId: v.id("jobs"),
    key: v.string(),
    reason: v.string(),
    nextAction: v.string(),
    dueAt: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    const day = await ownedActive(ctx, user, args.workdayId);
    await assignedJob(ctx, user, args.jobId);
    const entry = day.jobs.find((j) => j.jobId === args.jobId);
    if (!entry) throw new Error("This position is not on your workday.");
    const now = Date.now();
    const check = (await jobView(ctx, day, entry, now)).checks.find(
      (c) => c.key === args.key,
    );
    if (!check) throw new Error("That check is no longer outstanding.");
    validateCarry(check, args.reason, args.nextAction, args.dueAt, now);
    const row = await ctx.db
      .query("taWorkdayCarry")
      .withIndex("by_user_job", (q) =>
        q.eq("userId", user._id).eq("jobId", args.jobId),
      )
      .filter((q) => q.eq(q.field("key"), args.key))
      .first();
    const values = {
      userId: user._id,
      jobId: args.jobId,
      key: args.key,
      reason: args.reason.trim(),
      nextAction: args.nextAction.trim(),
      dueAt: args.dueAt,
      recordedAt: now,
      evidenceAt: check.evidenceAt,
    };
    if (row) await ctx.db.patch(row._id, values);
    else await ctx.db.insert("taWorkdayCarry", values);
    return { ok: true };
  },
});

export const finish = internalMutation({
  args: { actorId: v.string(), workdayId: v.id("taWorkdays") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    const existing = await ctx.db.get(args.workdayId);
    if (existing?.userId === user._id && existing.finishedAt !== undefined)
      return { ok: true, finishedAt: existing.finishedAt };
    const day = await ownedActive(ctx, user, args.workdayId);
    for (const entry of day.jobs) await assignedJob(ctx, user, entry.jobId);
    const now = Date.now();
    // The CV queue and finish write share a transaction: a concurrent arrival
    // invalidates the read and retries completion against the new queue.
    const snapshot = await view(ctx, day, now);
    const blockers = completionBlockers(snapshot.jobs);
    if (blockers.length)
      return { ok: false, blockers: blockers.map((c) => c.label) };
    snapshot.finishedAt = now;
    snapshot.requests = snapshot.requests.map((r) =>
      r.status === "pending"
        ? { ...r, status: "denied", reason: "Workday finished before approval" }
        : r,
    );
    await ctx.db.patch(day._id, { finishedAt: now, completion: snapshot });
    const seats = await ctx.db
      .query("taWorkdayLeads")
      .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
      .collect();
    for (const seat of seats) await ctx.db.patch(seat._id, { finishedAt: now });
    const requests = await ctx.db
      .query("taWorkdayRequests")
      .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
      .collect();
    for (const r of requests.filter((r) => r.status === "pending"))
      await ctx.db.patch(r._id, {
        status: "denied",
        decidedAt: now,
        reason: "Workday finished before approval",
      });
    for (const entry of day.jobs)
      await notify(
        ctx,
        entry.leadId,
        user,
        entry.jobId,
        "workday_finished",
        "Finished workday",
      );
    return { ok: true, finishedAt: now };
  },
});
