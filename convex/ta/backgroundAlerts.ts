import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { isGone } from "../../src/lib/bin";
import { hasWorkingHours } from "../../src/lib/calendar";
import { BACKGROUND_ALERT_ROLLOUT, backgroundAlertHref, backgroundDeadline, directorNeedsShortlist, inactivityStart, type BackgroundAlertKind, type BackgroundAlertView } from "../../src/lib/backgroundAlerts";

type Ctx = QueryCtx | MutationCtx;
const ref = (name: string) => makeFunctionReference<"mutation">(`ta/backgroundAlerts:${name}`);
const pageArgs = { cursor: v.optional(v.union(v.string(), v.null())) };
const PAGE = 30;
const isOpen = (job: Doc<"jobs"> | null) => !!job && ["active", "draft"].includes(job.status) && !isGone(job);
const epoch = (value: string | number | undefined) => typeof value === "number" ? value : Date.parse(value ?? "") || 0;

async function rolloutAt(ctx: Ctx) {
  const row = await ctx.db.query("taSettings").withIndex("by_key", q => q.eq("key", BACKGROUND_ALERT_ROLLOUT)).first();
  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function recruiters(ctx: Ctx, jobId: Id<"jobs">) {
  const rows = await ctx.db.query("jobAssignments").withIndex("by_jobId", q => q.eq("jobId", jobId)).collect();
  // Assignment history is authoritative; a revoked seat must not fall back to assignedTaIds.
  const seats = rows.filter(a => a.isActive && ["primary_recruiter", "supporting_recruiter"].includes(a.assignmentRole))
    .map(a => ({ _id: String(a._id), userId: a.userId, assignedAt: epoch(a.assignedAt) }));
  const job = await ctx.db.get(jobId);
  for (const userId of job?.assignedTaIds ?? []) if (!rows.some(a => a.userId === userId)) {
    seats.push({ _id: `legacy:${jobId}:${userId}`, userId, assignedAt: job?.assignedAt ?? epoch(job?.createdAt) });
  }
  const active = [];
  for (const seat of seats) {
    const user = await ctx.db.get(seat.userId);
    if (user?.isActive !== false && user) active.push(seat);
  }
  return [...new Map(active.map(a => [a.userId, a])).values()];
}

async function latestArrival(ctx: Ctx, jobId: Id<"jobs">) {
  // The index ends in _creationTime. This is arrival at this job, independent
  // of mixed legacy createdAt formats, edits, screening and stage changes.
  const app = await ctx.db.query("applications").withIndex("by_jobId", q => q.eq("jobId", jobId)).order("desc").first();
  return app?._creationTime ?? 0;
}

async function raise(ctx: MutationCtx, kind: BackgroundAlertKind, job: Doc<"jobs">, userId: Id<"users">,
  subjectId: string, incidentKey: string, detail: string, now: number, since: number) {
  const existing = await ctx.db.query("taAlerts").withIndex("by_incident_recipient", q => q.eq("incidentKey", incidentKey).eq("assignedTo", userId)).first();
  if (existing) {
    if (!existing.resolvedAt && existing.detail !== detail) await ctx.db.patch(existing._id, { detail });
    return;
  }
  const id = await ctx.db.insert("taAlerts", { kind, subjectType: kind === "director_no_shortlist" ? "review_round" : "opening",
    subjectId, openingId: job._id, incidentKey, assignedTo: userId, raisedAt: now, dueAt: backgroundDeadline(since), detail });
  // One transaction owns both records, including retries and overlapping cron sweeps.
  await ctx.db.insert("notifications", { userId, type: kind, title: kind === "job_no_new_candidates" ? "No new candidates" : "No director shortlist",
    body: detail, jobId: job._id, href: backgroundAlertHref(kind, job._id), alertId: id, read: false, createdAt: new Date(now).toISOString() });
}

async function manuallyShortlisted(ctx: Ctx, round: Doc<"reviewRounds">) {
  // A director/lead can record the decision by moving a card, without an email reply.
  for (const id of round.applicationIds) {
    const app = await ctx.db.get(id);
    if (app && ((app.currentStage === "director_shortlist" && app.lastStageChangedAt >= round.sentAt) ||
      app.stageHistory?.some(h => h.stage === "director_shortlist" && epoch(h.enteredAt) >= round.sentAt))) return true;
  }
  return false;
}

/** Read-only validation also hides resolved conditions before the next cron tick. */
export async function stillActive(ctx: Ctx, alert: Doc<"taAlerts">) {
  if (alert.resolvedAt || !alert.openingId || !alert.incidentKey) return false;
  const job = await ctx.db.get(alert.openingId);
  if (!isOpen(job)) return false;
  const assigned = await recruiters(ctx, alert.openingId);
  const seat = assigned.find(a => a.userId === alert.assignedTo);
  if (!seat) return false;
  const rollout = await rolloutAt(ctx);
  if (!rollout) return false;
  if (alert.kind === "job_no_new_candidates") {
    const since = inactivityStart(rollout, epoch(seat.assignedAt), await latestArrival(ctx, alert.openingId));
    return alert.incidentKey === `quiet:${job!._id}:${seat._id}:${since}` && hasWorkingHours(since, Date.now(), 24);
  }
  if (alert.kind === "director_no_shortlist") {
    const id = ctx.db.normalizeId("reviewRounds", alert.subjectId);
    const round = id ? await ctx.db.get(id) : null;
    return !!round && round.openingId === alert.openingId && round.sentBy === alert.assignedTo &&
      directorNeedsShortlist(round, rollout, Date.now()) && !await manuallyShortlisted(ctx, round);
  }
  return false;
}

export async function outstandingFor(ctx: Ctx, userId: Id<"users">): Promise<BackgroundAlertView[]> {
  const rows = await ctx.db.query("taAlerts").withIndex("by_recipient_resolved", q => q.eq("assignedTo", userId).lte("resolvedAt", null)).collect();
  const out: BackgroundAlertView[] = [];
  for (const row of rows) if (await stillActive(ctx, row)) out.push({ id: row._id, kind: row.kind as BackgroundAlertKind,
    openingId: row.openingId!, detail: row.detail, href: backgroundAlertHref(row.kind, row.openingId!), dueAt: row.dueAt });
  return out;
}

export const sweep = internalMutation({ args: {}, handler: async (ctx) => {
  if (!await rolloutAt(ctx)) return;
  for (const name of ["jobsPage", "roundsPage", "resolvePage"]) await ctx.scheduler.runAfter(0, ref(name), {});
} });

export const jobsPage = internalMutation({ args: pageArgs, handler: async (ctx, args) => {
  const page = await ctx.db.query("jobs").paginate({ cursor: args.cursor ?? null, numItems: PAGE });
  for (const job of page.page) if (isOpen(job)) await ctx.scheduler.runAfter(0, ref("checkJob"), { jobId: job._id });
  if (!page.isDone) await ctx.scheduler.runAfter(0, ref("jobsPage"), { cursor: page.continueCursor });
} });

export const checkJob = internalMutation({ args: { jobId: v.id("jobs") }, handler: async (ctx, args) => {
  const rollout = await rolloutAt(ctx);
  const job = await ctx.db.get(args.jobId);
  if (!rollout || !isOpen(job)) return;
  const arrival = await latestArrival(ctx, args.jobId);
  const now = Date.now();
  for (const seat of await recruiters(ctx, args.jobId)) {
    const since = inactivityStart(rollout, epoch(seat.assignedAt), arrival);
    if (hasWorkingHours(since, now, 24)) await raise(ctx, "job_no_new_candidates", job!, seat.userId, args.jobId,
      `quiet:${args.jobId}:${seat._id}:${since}`, `${job!.title} — no new candidates from any source for 24 working-day hours. Check the job’s sourcing and applications.`, now, since);
  }
} });

export const roundsPage = internalMutation({ args: pageArgs, handler: async (ctx, args) => {
  const rollout = await rolloutAt(ctx);
  if (!rollout) return;
  const page = await ctx.db.query("reviewRounds").withIndex("by_kind_dispatch_sent", q => q.eq("kind", "director").eq("dispatch", "sent").gte("sentAt", rollout))
    .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
  for (const round of page.page) if (directorNeedsShortlist(round, rollout, Date.now())) await ctx.scheduler.runAfter(0, ref("checkRound"), { roundId: round._id });
  if (!page.isDone) await ctx.scheduler.runAfter(0, ref("roundsPage"), { cursor: page.continueCursor });
} });

export const checkRound = internalMutation({ args: { roundId: v.id("reviewRounds") }, handler: async (ctx, args) => {
  const rollout = await rolloutAt(ctx);
  const round = await ctx.db.get(args.roundId);
  const now = Date.now();
  if (!rollout || !round || !directorNeedsShortlist(round, rollout, now)) return;
  if (await manuallyShortlisted(ctx, round)) return;
  const job = await ctx.db.get(round.openingId);
  if (!isOpen(job) || !(await recruiters(ctx, round.openingId)).some(a => a.userId === round.sentBy)) return;
  const lead = job!.taLeadId ? await ctx.db.get(job!.taLeadId) : null;
  const result = round.returnedAt || round.decisions.length || round.replyBody ? "Director shortlisted no candidates" : "No director reply";
  await raise(ctx, "director_no_shortlist", job!, round.sentBy, round._id, `director:${round._id}`,
    `${job!.title} — ${result} for your EOD submission after 24 working-day hours. Contact your TA Lead outside the system.${lead ? ` TA Lead: ${lead.fullName}.` : " Ask the job owner to confirm the TA Lead."}`, now, round.sentAt);
} });

export const resolvePage = internalMutation({ args: pageArgs, handler: async (ctx, args) => {
  const page = await ctx.db.query("taAlerts").withIndex("by_resolved", q => q.lte("resolvedAt", null))
    .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
  for (const row of page.page) if (row.incidentKey) await ctx.scheduler.runAfter(0, ref("resolveOne"), { alertId: row._id });
  if (!page.isDone) await ctx.scheduler.runAfter(0, ref("resolvePage"), { cursor: page.continueCursor });
} });

export const resolveOne = internalMutation({ args: { alertId: v.id("taAlerts") }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.alertId);
  if (row?.incidentKey && !row.resolvedAt && !await stillActive(ctx, row)) await ctx.db.patch(row._id, { resolvedAt: Date.now() });
} });
