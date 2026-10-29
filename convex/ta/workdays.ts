import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
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
import { finalizeDailyEmail, dailyEmailsFor, middayRequired } from "../lib/dailyEmail";
import { dailySendProblem } from "../../src/lib/dailyEmail";
import { requiredChecks, withTaskHistory } from "../lib/workdayChecks";
import { MAX_100_MESSAGE, MAX_100_PER_DAY, count100, researchMissing, researchVersion, workSessionStart } from "../../src/lib/workdayRequirements";
import { validateResearchLink } from "../../src/lib/eod-format";
import { canReviewWorkdays } from "../../src/lib/workdayRoles";
import {
  applyCarryForwards,
  canExcuseCheck,
  emailBlockers,
  checksForWorkType,
  validateCarry,
  workdayDate,
  type WorkdayCheck,
  type WorkdayJobView,
  type WorkdayView,
  type WorkType,
} from "../../src/lib/workday";
import { isEodCandidateEligible } from "../../src/lib/eodEligibility";
import { activeWorkLocationIds, inWorkLocation, requireWorkLocation } from "../../src/lib/workLocations";
import { acceptedEod, jobEodComplete } from "../lib/workLocationEmails";

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
  // Today's rows only. Reading the TA's whole history, each closed day with its
  // completion snapshot, grew with tenure and ran on every check (29 Oct).
  const days = await ctx.db.query("taWorkdays").withIndex("by_user_date", q => q.eq("userId", userId).eq("date", workdayDate(Date.now()))).collect();
  return days.find(d => d.finishedAt === undefined || d.closureReason === "eod") ?? null;
}

async function ownedActive(ctx: Ctx, user: Doc<"users">, id: Id<"taWorkdays">) {
  const day = await ctx.db.get(id);
  if (!day || day.userId !== user._id)
    throw new Error("That workday is not yours.");
  if (day.date !== workdayDate(Date.now())) throw new Error("Start today's workday first.");
  if (day.finishedAt !== undefined && day.closureReason !== "eod")
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
  const sent = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", jobId)).collect();
  if (sent.some(r => ["sending", "uncertain"].includes(r.status) || (r.status === "accepted" && !r.finalizedAt)))
    throw new Error("Wait for this position's email result or ask the lead to reconcile it before changing work type.");
  if (sent.some(r => r.status === "accepted" && r.finalizedAt && !r.revised && !r.recoveryReopenedAt && (r.submissionType ?? "eod") === "eod"))
    throw new Error("This position's EOD has been sent. Its recorded work type cannot change today.");
  if (stage === "100%" && count100(day.jobs) >= MAX_100_PER_DAY) throw new Error(MAX_100_MESSAGE);
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
  await autoCompleteWorkday(ctx, day._id);
}

async function suggestedMode(_ctx: Ctx, _userId: Id<"users">, _jobId: Id<"jobs">, requested: WorkType): Promise<WorkType> {
  return requested;
}

async function pendingJobs(ctx: Ctx, user: Doc<"users">) {
  const days = await ctx.db.query("taWorkdays").withIndex("by_user", q => q.eq("userId", user._id)).collect();
  const ids = new Set(days.filter(d => d.finishedAt !== undefined).flatMap(d => d.jobs.map(j => j.jobId)));
  const jobs: Doc<"jobs">[] = [];
  for (const id of ids) {
    const job = await ctx.db.get(id);
    if (!job || isGone(job) || ["closed", "filled", "cancelled"].includes(job.status)) continue;
    try { await assignedJob(ctx, user, id); } catch { continue; }
    const apps = await ctx.db.query("applications").withIndex("by_workday_owner", q => q.eq("jobId", id).eq("ownerTaId", user._id)).collect();
    if (apps.some(a => ["follow_up", "ta_shortlist", "ai_call", "second_shortlist"].includes(a.currentStage))) jobs.push(job);
    else {
      const carries = await ctx.db.query("taWorkdayCarry").withIndex("by_user_job", q => q.eq("userId", user._id).eq("jobId", id)).collect();
      let pending = false;
      for (const carry of carries.filter(c => c.key.startsWith("profile:"))) {
        const linkId = ctx.db.normalizeId("linkVault", carry.key.slice(8));
        const link = linkId ? await ctx.db.get(linkId) : null;
        const app = link?.candidateId ? apps.find(a => a.candidateId === link.candidateId) : null;
        if (link?.addedBy === user._id && link.openingId === id && link.outcome !== "declined" && (!app || !["rejected", "unresponsive", "placed"].includes(app.currentStage))) pending = true;
      }
      if (!pending) {
        const posts = await ctx.db.query("jobPosts").withIndex("by_opening", q => q.eq("openingId", id)).collect();
        const incoming = await ctx.db.query("applications").withIndex("by_job_stage_reviewed", q => q.eq("jobId", id).eq("currentStage", "new_cvs").eq("workdayReviewedAt", undefined)).collect();
        pending = incoming.some(a => !!a.jobPostId && posts.some(p => p._id === a.jobPostId && p.assignedTaId === user._id));
      }
      if (pending) jobs.push(job);
    }
  }
  return jobs;
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
  if (!existing.some((r) => r.leadId === leadId)) {
    const day = await ctx.db.get(workdayId);
    await ctx.db.insert("taWorkdayLeads", { workdayId, leadId, ...(day?.finishedAt !== undefined ? { finishedAt: day.finishedAt } : {}) });
  }
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
      evidence: String(evidenceAt),
      status: "incomplete",
      blocksEmail: key.startsWith("mail:"),
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
    (r) => r.kind === "director" && r.dispatch === "sent" && !r.recoveryReopenedAt,
  );
  // Historical rounds are the roster the existing composer already excludes.
  // Today's completion still requires a confirmed transport acknowledgement.
  const sentIds = new Set(
    rounds
      .filter(
        (r) =>
          r.kind === "director" && !r.recoveryReopenedAt &&
          (r.dispatch === "sent" || r.sentAt < day.startedAt),
      )
      .flatMap((r) => r.applicationIds as string[]),
  );
  for (const receipt of receipts.filter(
    (r) => r.status === "accepted" && r.finalizedAt && !r.recoveryReopenedAt,
  ))
    for (const id of receipt.applicationIds) sentIds.add(id);
  const today = accepted.filter(
    (r) => r.sentBy === day.userId && r.sentAt >= day.startedAt,
  );
  const completedReceipts = receipts.filter(
    (r) => r.status === "accepted" && r.finalizedAt && !r.recoveryReopenedAt,
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
          `details:${app._id}`,
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
  const required = await requiredChecks(ctx, day, entry);
  checks.push(...required.checks);
  for (const app of apps.filter(a => a.ownerTaId === day.userId && a.currentStage === "second_shortlist" && sentIds.has(a._id))) {
    add(`director_wait:${app._id}`, "Waiting for the Director's reply: record the next follow-up", "follow_up", `${base}/eod`, true, app.lastStageChangedAt);
  }
  const resolved = checksForWorkType(entry.workType, applyCarryForwards(checks, carries, now).map(c => ({ ...c, status: c.waiting ? "waiting" as const : c.status })));
  const eodChecks = checksForWorkType(entry.workType, required.eodChecks);
  const locationReceipts = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", entry.jobId)).collect();
  const allLocationEodsSent = await jobEodComplete(ctx, entry, locationReceipts);
  return {
    jobId: entry.jobId,
    title: job?.title ?? "Unavailable job",
    workType: entry.workType,
    eodSentAt: allLocationEodsSent ? Math.max(...locationReceipts.filter(acceptedEod).map(r => r.acceptedAt ?? r.finalizedAt!)) : undefined,
    checks: await withTaskHistory(ctx, day, entry.jobId, resolved, entry.workType === "100%"),
    eodChecks: await withTaskHistory(ctx, day, entry.jobId, eodChecks, false),
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

/**
 * A workday keeps its opening ids so restoring something from the Bin can put
 * it back exactly where it was. Current work, however, must never be blocked
 * or displayed by an opening that has left the desk.
 */
async function availableWorkdayEntries(
  ctx: Ctx,
  entries: Doc<"taWorkdays">["jobs"],
) {
  const jobs = await Promise.all(entries.map((entry) => ctx.db.get(entry.jobId)));
  return entries.filter((_, index) => {
    const job = jobs[index];
    return !!job && !isGone(job);
  });
}

async function availableWorkdayRequests(
  ctx: Ctx,
  requests: Doc<"taWorkdayRequests">[],
) {
  const jobs = await Promise.all(requests.map((request) => ctx.db.get(request.jobId)));
  return requests.filter((_, index) => {
    const job = jobs[index];
    return !!job && !isGone(job);
  });
}

async function view(
  ctx: Ctx,
  day: Doc<"taWorkdays">,
  now: number,
  live = false,
): Promise<WorkdayView> {
  if (day.finishedAt !== undefined && day.completion && !live)
    return withoutReturningTasks(day.completion as WorkdayView);
  const user = await ctx.db.get(day.userId);
  const storedRequests = await ctx.db
    .query("taWorkdayRequests")
    .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
    .collect();
  const entries = live ? await availableWorkdayEntries(ctx, day.jobs) : day.jobs;
  const requests = live
    ? await availableWorkdayRequests(ctx, storedRequests)
    : storedRequests;
  return {
    id: day._id,
    userId: day.userId,
    name: user?.fullName ?? "Unavailable user",
    date: day.date,
    startedAt: day.startedAt,
    finishedAt: day.finishedAt ?? null,
    closureReason: day.closureReason,
    jobs: await Promise.all(entries.map((j) => jobView(ctx, day, j, now))),
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

function withoutReturningTasks(day: WorkdayView): WorkdayView {
  return day;
}

/** Sending closes the clock, not the remaining returning-mode submissions. */
export async function autoCompleteWorkday(ctx: MutationCtx, id: Id<"taWorkdays">) {
  const day = await ctx.db.get(id);
  if (!day || day.finishedAt !== undefined) return;
  const entries = await availableWorkdayEntries(ctx, day.jobs);
  const receipts = (await Promise.all(entries.map(j => ctx.db.query("taWorkdayMail")
    .withIndex("by_workday_job", q => q.eq("workdayId", id).eq("jobId", j.jobId)).collect()))).flat()
    .filter(r => r.status === "accepted" && !!r.finalizedAt && !r.revised && !r.recoveryReopenedAt && (r.submissionType ?? "eod") === "eod");
  const completedJobs = new Set((await Promise.all(entries.map(async j => await jobEodComplete(ctx, j, receipts.filter(r => r.jobId === j.jobId)) ? j.jobId : null))).filter(Boolean));
  // A city submission cannot close attendance while another city's EOD is outstanding.
  if (entries.some(j => j.workLocationIds?.length && !completedJobs.has(j.jobId))) return;
  const primary = receipts.filter(r => {
    if (!completedJobs.has(r.jobId)) return false;
    const entry = entries.find(j => j.jobId === r.jobId);
    const recorded = entry?.modeHistory.filter(m => m.at <= r.startedAt).at(-1)?.workType;
    return (r.workType ?? recorded ?? entry?.workType) === "100%";
  });
  const allSent = entries.length > 0 && entries.every(j => completedJobs.has(j.jobId));
  const finishedAt = primary.length ? (entries.some(j => j.workLocationIds?.length) ? Math.max : Math.min)(...primary.map(r => r.acceptedAt ?? r.finalizedAt!))
    : !entries.some(j => j.workType === "100%") && allSent ? Math.max(...receipts.map(r => r.acceptedAt ?? r.finalizedAt!)) : null;
  if (finishedAt === null) return;
  await closeWorkday(ctx, day, finishedAt, "eod");
}

async function closeWorkday(ctx: MutationCtx, day: Doc<"taWorkdays">, at: number, reason: "eod" | "expired") {
  const snapshot = await view(ctx, { ...day, completion: undefined }, at);
  snapshot.finishedAt = at;
  snapshot.closureReason = reason;
  snapshot.requests = snapshot.requests.map(r => r.status === "pending" ? { ...r, status: "denied", reason: "Workday closed before approval" } : r);
  await ctx.db.patch(day._id, { finishedAt: at, closureReason: reason, completion: snapshot });
  const seats = await ctx.db.query("taWorkdayLeads").withIndex("by_workday", q => q.eq("workdayId", day._id)).collect();
  for (const seat of seats) await ctx.db.patch(seat._id, { finishedAt: at });
  const requests = await ctx.db.query("taWorkdayRequests").withIndex("by_workday", q => q.eq("workdayId", day._id)).collect();
  for (const request of requests.filter(r => r.status === "pending")) await ctx.db.patch(request._id, {
    status: "denied", decidedAt: at, reason: "Workday closed before approval",
  });
  if (reason === "eod") {
    const user = await ctx.db.get(day.userId);
    if (user) for (const entry of day.jobs) await notify(ctx, entry.leadId, user, entry.jobId, "workday_finished", "Workday completed by EOD email");
  }
}

async function recoverStaleDays(ctx: MutationCtx, userId: Id<"users">) {
  const days = await ctx.db.query("taWorkdays").withIndex("by_user_finished", q => q.eq("userId", userId).eq("finishedAt", undefined)).collect();
  for (const day of days.filter(d => d.date < workdayDate(Date.now()))) {
    await autoCompleteWorkday(ctx, day._id);
    if ((await ctx.db.get(day._id))?.finishedAt === undefined) {
      const midnight = Date.parse(`${day.date}T00:00:00+05:30`) + 86400000;
      await closeWorkday(ctx, day, midnight, "expired");
    }
  }
}

/** Pipeline only: never turns missing mail into a successful completed day. */
export const recoverOpenWorkdays = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const days = await ctx.db.query("taWorkdays").withIndex("by_finished", q => q.eq("finishedAt", undefined)).collect();
    const stale = days.filter(d => d.date < workdayDate(Date.now()));
    if (!args.dryRun) for (const userId of new Set(stale.map(d => d.userId))) await recoverStaleDays(ctx, userId);
    return { dryRun: args.dryRun, affected: stale.length };
  },
});

/** Run in the write transaction, never in a dashboard query. */
export async function refreshWorkdayChecks(ctx: MutationCtx, jobId: Id<"jobs">, actorId?: Id<"users">, onlyDay?: Id<"taWorkdays">) {
  const now = Date.now();
  // Only today's days are refreshed, so only today's are read: every open day
  // of every date was read too, then skipped (29 Oct).
  const days = onlyDay
    ? [await ctx.db.get(onlyDay)].filter((d): d is Doc<"taWorkdays"> => !!d && (d.finishedAt === undefined || d.closureReason === "eod"))
    : (await ctx.db.query("taWorkdays").withIndex("by_date", q => q.eq("date", workdayDate(now))).collect())
        .filter(d => d.finishedAt === undefined || d.closureReason === "eod");
  for (const day of days) {
    if (day.date !== workdayDate(now)) continue;
    const entry = day.jobs.find(j => j.jobId === jobId);
    if (!entry) continue;
    const result = await jobView(ctx, day, entry, now);
    const old = await ctx.db.query("taWorkdayTaskEvents").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", jobId)).collect();
    // The latest event per check, found once rather than a scan per check.
    const latest = new Map(old.map(e => [e.key, e]));
    for (const check of result.checks) {
      const previous = latest.get(check.key);
      const status = check.waiting ? "waiting" : check.status ?? "incomplete";
      const evidence = check.waiting ? JSON.stringify(check.waiting) : check.evidence;
      if (previous?.status === status && previous.evidence === evidence) continue;
      const completedAt = status === "complete" ? previous?.status === "complete" ? previous.completedAt ?? check.completedAt : check.completedAt ?? (previous?.status === "incomplete" && actorId ? now : undefined) : undefined;
      const completedBy = status === "complete" ? previous?.status === "complete" ? previous.completedBy : completedAt ? check.completedBy ?? actorId : undefined : undefined;
      await ctx.db.insert("taWorkdayTaskEvents", { workdayId: day._id, userId: day.userId, jobId,
        key: check.key, label: check.label, href: check.href, kind: check.kind, status, at: now,
        ...(actorId ? { by: actorId } : {}), ...(evidence ? { evidence } : {}),
        ...(completedAt ? { completedAt } : {}), ...(completedBy ? { completedBy } : {}),
        ...(status === "complete" && (!previous || !completedAt) ? { observed: true } : {}) });
    }
  }
}

/** The Suggestions page uses the same scoped evidence as the sidebar and saveCheck. */
export const suggestionsCheck = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId); requireWorker(user);
    await assignedJob(ctx, user, args.jobId);
    const day = await activeFor(ctx, user._id);
    const entry = day?.jobs.find(j => j.jobId === args.jobId);
    if (!day || !entry) return null;
    const evidence = await requiredChecks(ctx, day, entry);
    return evidence.suggestionsCheck;
  },
});

export const saveCheck = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), kind: v.union(v.literal("jd"), v.literal("research"), v.literal("emptySuggestions"), v.literal("noCandidates"), v.literal("chatgpt")),
    reason: v.optional(v.string()), reasons: v.optional(v.record(v.string(), v.string())), link: v.optional(v.string()), confirmed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId); requireWorker(user);
    await assignedJob(ctx, user, args.jobId);
    const day = await activeFor(ctx, user._id);
    if (!day || !day.jobs.some(j => j.jobId === args.jobId)) throw new Error("Start work on this opening first.");
    const entry = day.jobs.find(j => j.jobId === args.jobId)!;
    const evidence = await requiredChecks(ctx, day, entry);
    const now = Date.now();
    const patch: Record<string, unknown> = evidence.notes?.workdayId !== day._id
      ? { noCandidateReason: undefined, noCandidateAt: undefined, chatgptLink: undefined, confirmedAt: undefined } : {};
    const reason = args.reason?.trim();
    if (args.kind === "jd") {
      if (!evidence.job?.jobDescription?.trim() || evidence.job.jdStatus !== "approved") throw new Error("Review and approve the job description first.");
      Object.assign(patch, { jdVersion: evidence.job.jobDescription, jdReviewedAt: evidence.notes?.jdVersion === evidence.job.jobDescription ? evidence.notes.jdReviewedAt ?? now : now });
    } else if (args.kind === "research") {
      if (!evidence.research) throw new Error("Run Research first.");
      const reasons = args.reasons ?? evidence.notes?.unavailableReasons ?? {};
      if (Object.values(reasons).some(r => typeof r !== "string" || r.length > 1000)) throw new Error("Keep each unavailable reason under 1,000 characters.");
      const missing = researchMissing(evidence.research.fields, reasons);
      if (missing.length) throw new Error(`Fill these fields or record why unavailable: ${missing.join(", ")}.`);
      Object.assign(patch, { unavailableReasons: reasons, researchVersion: researchVersion(evidence.research), researchReviewedAt: evidence.notes?.researchVersion === researchVersion(evidence.research) ? evidence.notes.researchReviewedAt ?? now : now });
    } else if (args.kind === "emptySuggestions") {
      if (!evidence.latestRun || evidence.latest.length) throw new Error("Only a successful empty search needs this reason.");
      if (!reason || reason.length > 1000) throw new Error("Give a reason under 1,000 characters.");
      Object.assign(patch, { emptySuggestionsVersion: evidence.suggestionVersion, emptySuggestionsReason: reason, emptySuggestionsAt: now });
    } else if (args.kind === "noCandidates") {
      if (!reason || reason.length > 1000) throw new Error("Explain why no suitable candidates were found (under 1,000 characters).");
      Object.assign(patch, { workdayId: day._id, noCandidateReason: reason, noCandidateAt: now });
    } else {
      const checked = validateResearchLink(args.link);
      if (!checked.ok) throw new Error(checked.reason);
      // Saving this check means confirming it, not saving an unconfirmed draft
      // that answers "Saved" while leaving the sidebar incomplete (14 Oct).
      if (!args.confirmed) throw new Error("Confirm you opened this link in a private window and it contains no candidate details before saving.");
      Object.assign(patch, { workdayId: day._id, chatgptLink: checked.url, confirmedAt: evidence.notes?.workdayId === day._id && evidence.notes.chatgptLink === checked.url ? evidence.notes.confirmedAt ?? now : now });
    }
    if (evidence.notes) await ctx.db.patch(evidence.notes._id, patch);
    else await ctx.db.insert("taWorkdayCheckNotes", { userId: user._id, jobId: args.jobId, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
    await refreshWorkdayChecks(ctx, args.jobId, user._id);
    return { ok: true };
  },
});

export const recordSourcingRun = internalMutation({
  args: { jobId: v.id("jobs"), userId: v.optional(v.id("users")), round: v.number(), count: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("taSourcingRuns", { ...args, at: Date.now() });
    await refreshWorkdayChecks(ctx, args.jobId, args.userId);
  },
});

export const refreshDueChecks = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => { await refreshWorkdayChecks(ctx, args.jobId); },
});

/**
 * Start's carried positions, one per run (29 Oct). Refreshing all of them
 * inside Start made attendance wait on, and fail with, every carried job's
 * evidence: fifteen carried positions meant fifteen checklists in one
 * mutation. The drawer works checks out live, so only the task history waits.
 * Scoped to the one day: other TAs' days on the job are not this Start's work.
 */
export const refreshCarried = internalMutation({
  args: { workdayId: v.id("taWorkdays"), jobIds: v.array(v.id("jobs")) },
  handler: async (ctx, args) => {
    const [jobId, ...rest] = args.jobIds;
    if (!jobId) return;
    await refreshWorkdayChecks(ctx, jobId, undefined, args.workdayId);
    if (rest.length) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("ta/workdays:refreshCarried"), { workdayId: args.workdayId, jobIds: rest });
  },
});

/** The 100% checklist preview for the one position picked before Start. */
export const startPreview = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId); requireWorker(user);
    await assignedJob(ctx, user, args.jobId);
    const now = Date.now();
    const previewDay = { _id: "preview" as Id<"taWorkdays">, userId: user._id, date: workdayDate(now), startedAt: now, jobs: [] } as unknown as Doc<"taWorkdays">;
    // A preview uses only real saved evidence and cannot insert task events.
    const evidence = await requiredChecks(ctx, previewDay, { jobId: args.jobId, workType: "100%", addedAt: now, modeHistory: [] });
    return { jobId: args.jobId, checks: evidence.checks };
  },
});

/** The server-authoritative mode and current session used by the EOD preview. */
export const eodContext = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    await assignedJob(ctx, user, args.jobId);
    const day = await activeFor(ctx, user._id);
    const entry = day?.jobs.find(j => j.jobId === args.jobId);
    if (entry) return { workType: entry.workType, sessionStart: workSessionStart(entry) };

    const assignment = await ctx.db.query("jobAssignments")
      .withIndex("by_jobId_userId", q => q.eq("jobId", args.jobId).eq("userId", user._id))
      .first();
    if (assignment?.isActive && assignment.workingStage) {
      return { workType: assignment.workingStage, sessionStart: null };
    }
    const held = await ctx.db.query("taSettings")
      .withIndex("by_key", q => q.eq("key", workingStageKey(args.jobId, user._id)))
      .first();
    const saved = held?.value;
    const stage: WorkType = saved === "Follow-up" || saved === "Add-on" ? saved : "100%";
    return { workType: stage, sessionStart: null };
  },
});

export const emailPreflight = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), link: v.string(), confirmed: v.boolean(), revised: v.optional(v.boolean()), workLocationId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    if (!["ta", "ta_support"].includes(roleOf(user))) return { ok: true, blockers: [], workType: "100%" as const };
    const day = await activeFor(ctx, user._id);
    if (!day) throw new Error("Start your workday in Today's Checks before sending.");
    const entry = day.jobs.find(j => j.jobId === args.jobId);
    if (!entry) throw new Error("Add this opening to Today's Checks first.");
    await assignedJob(ctx, user, args.jobId);
    const link = validateResearchLink(args.link);
    const excused = !args.link.trim() && !!(await requiredChecks(ctx, day, entry)).eodChecks.find(c => c.key.startsWith("chatgpt:"))?.exception;
    if (!excused && (!link.ok || !args.confirmed)) throw new Error(link.ok ? "Confirm your ChatGPT link before sending." : link.reason);
    if (link.ok && args.confirmed) {
      const notes = await ctx.db.query("taWorkdayCheckNotes").withIndex("by_user_job", q => q.eq("userId", user._id).eq("jobId", args.jobId)).first();
      const patch = { workdayId: day._id, chatgptLink: link.url, confirmedAt: notes?.workdayId === day._id && notes.chatgptLink === link.url ? notes.confirmedAt ?? Date.now() : Date.now(),
        ...(notes?.workdayId !== day._id ? { noCandidateReason: undefined, noCandidateAt: undefined } : {}) };
      if (notes) await ctx.db.patch(notes._id, patch);
      else await ctx.db.insert("taWorkdayCheckNotes", { userId: user._id, jobId: args.jobId, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
    }
    await refreshWorkdayChecks(ctx, args.jobId, user._id);
    const result = await jobView(ctx, day, entry, Date.now());
    const location = requireWorkLocation((await ctx.db.get(args.jobId))!, args.workLocationId);
    const blockers = emailBlockers([result]).filter(c => !location || !["director_cv", "midday_email", "mail"].includes(c.key.split(":")[0]));
    const reasons = blockers.map(c => `${c.label}: ${c.progress ?? "needs action"}`);
    if (location) {
      const emails = (await dailyEmailsFor(ctx, user._id, args.jobId, day.date)).filter(e => inWorkLocation(e, location.id));
      const problem = dailySendProblem(emails, "eod", await middayRequired(ctx, day.date));
      if (problem) reasons.push(problem);
    }
    return { ok: !reasons.length, blockers: reasons, workType: entry.workType };
  },
});

export const dashboard = internalQuery({
  args: { actorId: v.string(), detail: v.optional(v.boolean()), cursor: v.optional(v.string()), date: v.optional(v.string()), focusWorkday: v.optional(v.string()), taId: v.optional(v.string()), allHistory: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const role = roleOf(user);
    const worker = ["ta", "ta_support"].includes(role);
    const lead = canLead(user);
    const review = canReviewWorkdays(role);
    const deskWide = role === "admin" || role === "director" || role === "ta_lead";
    if (!worker && !review) throw new Error("You cannot access workdays.");
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
        canReview: review,
        role,
        lastFinishedAt,
        lastFinishedDate,
        active: active ? await view(ctx, active, now, true) : null,
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
    // Only the openings this person is assigned to are read. Reading every
    // opening (with its embedding and saved match results) went over the
    // backend's 16 MB per-query limit, and Today's Checks showed "Could not
    // load workday checks" for TAs and admins alike (28 Oct). Saving an
    // opening writes a jobAssignments row for each TA, and assignedJob (used
    // to add a position) goes by those rows too.
    const assignedIds = new Set(
      assignments
        .filter((a) => recruiters.includes(a.assignmentRole))
        .map((a) => a.jobId as string),
    );
    const assignedJobs = await Promise.all(
      [...assignedIds].map((id) => ctx.db.get(id as Id<"jobs">)),
    );
    const selectableJobs = assignedJobs.filter((job): job is Doc<"jobs"> => !!job);
    const assignmentModes = new Map(assignments.map(a => [a.jobId as string, a.workingStage]));
    // Only a position with no stage of its own needs the history, and only its
    // last 30 days: every workday ever read, each with its saved completion,
    // was most of the 16 MB this query read and ran past the 1 s limit (29 Oct).
    // shortcut: a position last worked over 30 days ago shows as 100% again, not Follow-up.
    const previousDays = worker && selectableJobs.some(j => !assignmentModes.get(j._id))
      ? await ctx.db.query("taWorkdays").withIndex("by_user", q => q.eq("userId", user._id)).order("desc").take(30)
      : [];
    const workedJobs = new Set(previousDays.filter(d => d.finishedAt !== undefined).flatMap(d => d.jobs.map(j => j.jobId)));
    const options = worker
      ? selectableJobs
          .filter(
            (j) =>
              !isGone(j) && !["closed", "filled", "cancelled"].includes(j.status) &&
              (assignedIds.has(j._id) || j.assignedTaIds?.includes(user._id)),
          )
          .map((j) => ({
            id: j._id,
            title: j.title,
            workType: assignmentModes.get(j._id) ?? (workedJobs.has(j._id) ? "Follow-up" as const : "100%" as const),
            carry: false,
          }))
      : [];
    const carryIds = !active && worker ? new Set((await pendingJobs(ctx, user)).map(j => j._id)) : new Set<string>();
    // The checklist preview is fetched for the one position picked
    // (startPreview); building one for every assigned option on every poll
    // made the drawer itself slow before Start (29 Oct).
    if (!active) for (const option of options) option.carry = carryIds.has(option.id);
    // The last two days come with every load; earlier ones only when the TA
    // presses "Load earlier workdays". Fifteen days were read on every
    // 20-second poll whether or not anyone opened them (28 Oct).
    const history = worker
      ? await ctx.db
          .query("taWorkdays")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .order("desc")
          .take(args.allHistory ? 15 : 2)
      : [];
    let recent: Doc<"taWorkdays">[] = [];
    let nextCursor: string | null = null;
    if (review && !args.date && !args.focusWorkday) {
      if (deskWide) {
        const [working, page] = await Promise.all([
          ctx.db
            .query("taWorkdays")
            .withIndex("by_finished", (q) => q.eq("finishedAt", undefined))
            .take(100),
          ctx.db.query("taWorkdays").order("desc").paginate({ cursor: args.cursor ?? null, numItems: 20 }),
        ]);
        recent = [
          ...new Map([...working, ...page.page].map((d) => [d._id, d])).values(),
        ];
        nextCursor = page.isDone ? null : page.continueCursor;
      } else {
        const [working, page] = await Promise.all([
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
            .paginate({ cursor: args.cursor ?? null, numItems: 20 }),
        ]);
        const ids = [
          ...new Set([...working, ...page.page].map((d) => d.workdayId)),
        ];
        nextCursor = page.isDone ? null : page.continueCursor;
        recent = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
          (d): d is Doc<"taWorkdays"> => !!d,
        );
      }
    }
    // Filter the date before pagination; filtering a recent page hid older days.
    if (review && args.date && !args.focusWorkday) {
      const taId = args.taId ? ctx.db.normalizeId("users", args.taId) : null;
      let query = ctx.db.query("taWorkdays")
        .withIndex("by_date", q => q.eq("date", args.date!));
      if (args.taId) query = query.filter(q => q.eq(q.field("userId"), taId));
      const page = await query.order("desc").paginate({ cursor: args.cursor ?? null, numItems: 20 });
      recent = page.page;
      nextCursor = page.isDone ? null : page.continueCursor;
    }
    // Assignment choices must exist even before a TA starts a workday.
    // From the small assignment rows, not a scan of every opening (see above):
    // only openings with a recruiter on them can list a TA here.
    const allAssignments = review ? await ctx.db.query("jobAssignments").collect() : [];
    const byJob = new Map<string, Doc<"jobAssignments">[]>();
    for (const a of allAssignments) if (a.isActive && recruiters.includes(a.assignmentRole)) byJob.set(a.jobId as string, [...(byJob.get(a.jobId as string) ?? []), a]);
    const reviewJobs = (await Promise.all([...byJob.keys()].map((id) => ctx.db.get(id as Id<"jobs">))))
      .filter((job): job is Doc<"jobs"> => !!job);
    const teamAssignments = review ? await Promise.all(reviewJobs
      .filter(job => !isGone(job) && (deskWide || job.taLeadId === user._id))
      .map(async job => {
        const assigned = byJob.get(job._id as string) ?? [];
        const ids = new Set([...(job.assignedTaIds ?? []), ...assigned
          .filter(a => a.isActive && recruiters.includes(a.assignmentRole)).map(a => a.userId)]);
        const users = await Promise.all([...ids].map(id => ctx.db.get(id)));
        return users.filter((ta): ta is Doc<"users"> => !!ta && ta.isActive && ["ta", "ta_support"].includes(roleOf(ta)))
          .map(ta => ({ userId: ta._id, name: mapUser(ta).name, jobId: job._id, title: job.title }));
      })) : [];
    const team: WorkdayView[] = [];
    // Notification links can target older workdays outside the current page.
    // The normal per-job visibility checks below still apply.
    if (review && args.focusWorkday) {
      const id = ctx.db.normalizeId("taWorkdays", args.focusWorkday);
      const focused = id ? await ctx.db.get(id) : null;
      recent = focused ? [focused] : [];
    }
    for (const day of recent) {
      if (args.date && day.date !== args.date) continue;
      const visibleJobs =
        deskWide
          ? day.jobs
          : day.jobs.filter((j) => j.leadId === user._id);
      const requests = await ctx.db
        .query("taWorkdayRequests")
        .withIndex("by_workday", (q) => q.eq("workdayId", day._id))
        .collect();
      const visibleRequests =
        deskWide
          ? requests
          : requests.filter((r) => r.leadId === user._id);
      if (!visibleJobs.length && !visibleRequests.length) continue;
      // Reviewers can inspect all teams; management rights remain per job.
      const scoped = { ...day, jobs: visibleJobs, completion: undefined };
      const result =
        day.finishedAt !== undefined && day.completion && !(day.closureReason === "eod" && day.date === workdayDate(now))
          ? {
              ...(day.completion as WorkdayView),
              jobs: (day.completion as WorkdayView).jobs.filter((j) =>
                visibleJobs.some((v) => v.jobId === j.jobId),
              ),
            }
          : await view(ctx, scoped, now, true);
      result.requests = result.requests.filter((r) =>
        visibleRequests.some((v) => v._id === r.id),
      );
      if (!result.jobs.length && !result.requests.length) continue;
      for (const job of result.jobs) job.canManage = lead && (role === "admin" || day.jobs.some(entry => entry.jobId === job.jobId && entry.leadId === user._id));
      for (const request of result.requests) request.canManage = lead && (role === "admin" || visibleRequests.some(entry => entry._id === request.id && entry.leadId === user._id));
      team.push(withoutReturningTasks(result));
    }
    return {
      canWork: worker,
      canLead: lead,
      canReview: review,
      role,
      lastFinishedAt,
      lastFinishedDate,
      active: active ? await view(ctx, active, now, true) : null,
      history: await Promise.all(
        history
          .filter((d) => d.finishedAt !== undefined)
          .map((d) => view(ctx, d, now)),
      ),
      team,
      teamAssignments: teamAssignments.flat(),
      teamMembers: review ? (await ctx.db.query("users").collect())
        .filter(ta => ta.isActive && ["ta", "ta_support"].includes(roleOf(ta)))
        .map(ta => ({ userId: ta._id, name: mapUser(ta).name })) : [],
      options,
      nextCursor,
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
    if ((await ctx.db.get(args.jobId))?.workLocations?.length) throw new Error("Use the location's EOD composer to send this job's email.");
    const day = await activeFor(ctx, user._id);
    if (!day || !day.jobs.some((j) => j.jobId === args.jobId))
      return { id: null };
    await assignedJob(ctx, user, args.jobId);
    const entry = day.jobs.find(j => j.jobId === args.jobId)!;
    const current = await jobView(ctx, day, entry, Date.now());
    const blockers = emailBlockers([current]).filter(c => !c.key.startsWith("mail:"));
    if (blockers.length) throw new Error(`Complete Today's Checks before sending: ${blockers.map(c => c.label).join("; ")}.`);
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
    if (!args.applicationIds.length && previous.some(r => r.status === "accepted" && !r.recoveryReopenedAt))
      throw new Error("This activity email has already been sent in this workday.");
    if (previous.some(r => r.status === "accepted" && r.finalizedAt && !r.revised && !r.recoveryReopenedAt && (r.submissionType ?? "eod") === "eod"))
      throw new Error("The end-of-day email has already been sent. Edit and resend the saved email.");
    const sentToday = new Set(
      previous
        .filter((r) => r.status === "accepted" && !r.recoveryReopenedAt)
        .flatMap((r) => r.applicationIds as string[]),
    );
    if (args.applicationIds.some((id) => sentToday.has(id)))
      throw new Error(
        "These candidates have already been sent in this workday.",
      );
    const sessionStart = workSessionStart(entry);
    for (const id of args.applicationIds) {
      const app = await ctx.db.get(id);
      if (
        !app ||
        app.jobId !== args.jobId ||
        !isEodCandidateEligible({
          stage: app.currentStage,
          ownerTaId: app.ownerTaId,
          isAddOn: app.isAddOn,
          lastStageChangedAt: app.lastStageChangedAt,
        }, { taId: user._id, workType: entry.workType, sessionStart })
      )
        throw new Error(
          entry.workType === "Add-on"
            ? "Send only your Add-on candidates progressed to Director Review in this Add-on session."
            : "Send only your candidates who are in Director Review.",
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
      workType: entry.workType,
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
    if (!receipt.finalizedAt) await ctx.db.patch(receipt._id, { finalizedAt: receipt.acceptedAt ?? Date.now() });
    await autoCompleteWorkday(ctx, receipt.workdayId);
    await refreshWorkdayChecks(ctx, receipt.jobId, user._id);
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
    if (receipt.finalizedAt)
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
      if (receipt.dailyEmailId) {
        const email = await ctx.db.get(receipt.dailyEmailId);
        if (!email) throw new Error("The saved email could not be found.");
        await ctx.db.patch(email._id, { status: "accepted", acceptedAt: email.acceptedAt ?? now,
          reconciledBy: lead._id, reconciliationReason: args.reason.trim() });
        await finalizeDailyEmail(ctx, { ...email, status: "accepted", acceptedAt: email.acceptedAt ?? now });
      }
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
      if (!exists && !receipt.dailyEmailId)
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
    if (!args.accepted && receipt.dailyEmailId) await ctx.db.patch(receipt.dailyEmailId, {
      status: "failed", reconciledBy: lead._id, reconciliationReason: args.reason.trim(),
    });
    await ctx.db.patch(receipt._id, {
      status: args.accepted ? "accepted" : "failed",
      acceptedAt: args.accepted ? (receipt.acceptedAt ?? now) : undefined,
      finalizedAt: args.accepted ? now : undefined,
      reconciledAt: now,
      reconciledBy: lead._id,
      reconciliationReason: args.reason.trim(),
    });
    await refreshWorkdayChecks(ctx, receipt.jobId, lead._id);
    if (args.accepted) await autoCompleteWorkday(ctx, day._id);
    return { ok: true };
  },
});

export const start = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), workType },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    // A repeated Start (double click, a retry after a lost answer) returns
    // today's day before any other work, so it can never create a second one
    // or pay for old-day recovery again (29 Oct).
    const active = await activeFor(ctx, user._id);
    if (active) return { id: active._id };
    await recoverStaleDays(ctx, user._id);
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
    const mode = await suggestedMode(ctx, user._id, args.jobId, args.workType);
    const now = Date.now();
    const carry = (await pendingJobs(ctx, user)).filter(j => j._id !== args.jobId);
    const id = await ctx.db.insert("taWorkdays", {
      userId: user._id,
      date: workdayDate(now),
      startedAt: now,
      jobs: [
        {
          jobId: args.jobId,
          workType: mode,
          addedAt: now,
          leadId: job.taLeadId,
          workLocationIds: activeWorkLocationIds(job),
          modeHistory: [{ at: now, workType: mode }],
        },
        ...carry.map(j => ({ jobId: j._id, workType: "Follow-up" as const, addedAt: now, leadId: j.taLeadId, workLocationIds: activeWorkLocationIds(j), carried: true, modeHistory: [{ at: now, workType: "Follow-up" }] })),
      ],
    });
    await setMode(ctx, user._id, args.jobId, mode);
    await attachLead(ctx, id, job.taLeadId);
    await notify(
      ctx,
      job.taLeadId,
      user,
      args.jobId,
      "workday_started",
      "Started workday",
    );
    for (const j of carry) { await setMode(ctx, user._id, j._id, "Follow-up"); await attachLead(ctx, id, j.taLeadId); }
    await refreshWorkdayChecks(ctx, args.jobId);
    // Scheduled inside this mutation, so it commits or rolls back with the day.
    if (carry.length) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("ta/workdays:refreshCarried"), { workdayId: id, jobIds: carry.map(j => j._id) });
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
    if (day.jobs.filter(j => !j.carried).length >= 10)
      throw new Error("A workday supports at most ten positions.");
    const job = await assignedJob(ctx, user, args.jobId);
    const mode = await suggestedMode(ctx, user._id, args.jobId, args.workType);
    if (mode === "100%" && count100(day.jobs) >= MAX_100_PER_DAY) throw new Error(MAX_100_MESSAGE);
    const now = Date.now();
    await ctx.db.patch(day._id, {
      jobs: [
        ...day.jobs,
        {
          jobId: job._id,
          workType: mode,
          addedAt: now,
          leadId: job.taLeadId,
          workLocationIds: activeWorkLocationIds(job),
          modeHistory: [{ at: now, workType: mode }],
        },
      ],
    });
    await setMode(ctx, user._id, job._id, mode);
    await attachLead(ctx, day._id, job.taLeadId);
    await notify(
      ctx,
      job.taLeadId,
      user,
      job._id,
      "workday_started",
      "Started work on another position",
    );
    await refreshWorkdayChecks(ctx, args.jobId);
    return { pending: false };
  },
});

export const setWorkType = internalMutation({
  args: { actorId: v.string(), workdayId: v.id("taWorkdays"), jobId: v.id("jobs"), workType },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId); requireWorker(user);
    const day = await ownedActive(ctx, user, args.workdayId);
    await assignedJob(ctx, user, args.jobId);
    const entry = day.jobs.find(j => j.jobId === args.jobId);
    if (!entry) throw new Error("This opening is not on your workday.");
    const mode = await suggestedMode(ctx, user._id, args.jobId, args.workType);
    if (mode !== args.workType) throw new Error("Use the suggested work type for this opening.");
    if (entry.carried && mode === "Add-on" && day.jobs.filter(j => !j.carried).length >= 10) throw new Error("A workday supports at most ten selected positions.");
    await recordActiveMode(ctx, user._id, args.jobId, mode);
    if (entry.carried && mode === "Add-on") {
      const latest = await ctx.db.get(day._id);
      await ctx.db.patch(day._id, { jobs: latest!.jobs.map(j => j.jobId === args.jobId ? { ...j, carried: false } : j) });
    }
    await setMode(ctx, user._id, args.jobId, mode);
    await refreshWorkdayChecks(ctx, args.jobId, user._id);
    return { ok: true };
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
      const mode = await suggestedMode(ctx, user._id, job._id, request.workType);
      if (day.jobs.filter(j => !j.carried).length >= 10)
        throw new Error("The workday already has ten positions.");
      if (mode === "100%" && !day.jobs.some(j => j.jobId === job._id) && count100(day.jobs) >= MAX_100_PER_DAY) throw new Error(MAX_100_MESSAGE);
      if (!day.jobs.some((j) => j.jobId === job._id))
        await ctx.db.patch(day._id, {
          jobs: [
            ...day.jobs,
            {
              jobId: job._id,
              workType: mode,
              addedAt: now,
              leadId: job.taLeadId,
              workLocationIds: activeWorkLocationIds(job),
              modeHistory: [{ at: now, workType: mode }],
            },
          ],
        });
      await setMode(ctx, user._id, job._id, request.workType);
      await attachLead(ctx, day._id, job.taLeadId);
      await refreshWorkdayChecks(ctx, job._id);
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
      (day.finishedAt !== undefined && day.closureReason !== "eod") ||
      day.date !== workdayDate(Date.now()) ||
      !app ||
      !day.jobs.some((j) => j.jobId === app.jobId)
    )
      throw new Error("This CV is not on an active workday.");
    const sent = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", app.jobId)).collect();
    if (sent.some(r => inWorkLocation(r, app.workLocationId ?? "") && acceptedEod(r))) throw new Error("This CV is not on an active workday; its location's EOD has been sent.");
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
    await refreshWorkdayChecks(ctx, app.jobId, user._id);
    return { ok: true };
  },
});

export const taskException = internalMutation({
  args: { actorId: v.string(), workdayId: v.id("taWorkdays"), jobId: v.id("jobs"), key: v.string(), reason: v.string(), withdraw: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    const day = await ownedActive(ctx, user, args.workdayId);
    const receipts = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", args.jobId)).collect();
    const workEntry = day.jobs.find(j => j.jobId === args.jobId);
    if (workEntry && await jobEodComplete(ctx, workEntry, receipts)) throw new Error("This position is already finished by its EOD emails.");
    if (day.date !== workdayDate(Date.now())) throw new Error("Record reasons on today's workday.");
    const job = await assignedJob(ctx, user, args.jobId);
    const entry = day.jobs.find(j => j.jobId === args.jobId);
    if (!entry) throw new Error("This position is not on your workday.");
    const check = (await requiredChecks(ctx, day, entry)).eodChecks.find(c => c.key === args.key);
    if (!check || !canExcuseCheck(check) || !check.exceptionVersion) throw new Error("This task must be completed.");
    if (check.status === "complete" && !args.withdraw) throw new Error("This task is already complete.");
    const reason = args.reason.trim();
    if (!args.withdraw && (!reason || reason.length > 1000)) throw new Error("Give a reason of up to 1,000 characters.");
    const previous = (await ctx.db.query("taWorkdayExceptions").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", args.jobId)).collect()).filter(e => e.key === args.key).at(-1);
    const action = args.withdraw ? "withdraw" as const : "submit" as const;
    if (previous?.action === action && (args.withdraw || (previous.reason === reason && previous.version === check.exceptionVersion))) return { ok: true };
    if (args.withdraw && !previous) return { ok: true };
    const at = Date.now();
    await ctx.db.insert("taWorkdayExceptions", { workdayId: day._id, userId: user._id, jobId: args.jobId, key: args.key,
      reason: args.withdraw ? previous!.reason : reason, version: check.exceptionVersion, at, by: user._id, action });
    const recipients = (await ctx.db.query("users").collect()).filter(u => u.isActive && (roleOf(u) === "admin" || u._id === (entry.leadId ?? job.taLeadId)));
    for (const recipient of recipients) await ctx.db.insert("notifications", { userId: recipient._id, type: "workday_exception", jobId: args.jobId,
      workdayId: day._id, taskKey: args.key, title: `${user.fullName}: ${args.withdraw ? "reason withdrawn" : "reason submitted"}`,
      body: `${job.title} · ${check.label} · ${args.withdraw ? previous!.reason : reason}`, read: false, createdAt: new Date(at).toISOString() });
    await refreshWorkdayChecks(ctx, args.jobId, user._id);
    return { ok: true };
  },
});

export const researchExceptionAllowed = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    if (!["ta", "ta_support"].includes(roleOf(user))) return false;
    await assignedJob(ctx, user, args.jobId);
    const day = await activeFor(ctx, user._id);
    const entry = day?.jobs.find(j => j.jobId === args.jobId);
    if (!day || !entry) return false;
    return !!(await requiredChecks(ctx, day, entry)).eodChecks.find(c => c.key.startsWith("chatgpt:"))?.exception;
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
    await refreshWorkdayChecks(ctx, args.jobId, user._id);
    await ctx.scheduler.runAt(args.dueAt, makeFunctionReference<"mutation">("ta/workdays:refreshDueChecks"), { jobId: args.jobId });
    return { ok: true };
  },
});

export const finish = internalMutation({
  args: { actorId: v.string(), workdayId: v.id("taWorkdays") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireWorker(user);
    const existing = await ctx.db.get(args.workdayId);
    if (!existing || existing.userId !== user._id) throw new Error("That workday is not yours.");
    if (existing?.userId === user._id && existing.finishedAt !== undefined)
      return { ok: true, finishedAt: existing.finishedAt };
    throw new Error("Your workday completes automatically when the required EOD email is sent.");
  },
});
