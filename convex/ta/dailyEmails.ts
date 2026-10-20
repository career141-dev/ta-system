import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess } from "./guard";
import { mapUser } from "../../src/data/convex/map";
import { workdayDate } from "../../src/lib/workday";
import { isEodCandidateEligible } from "../../src/lib/eodEligibility";
import { workSessionStart } from "../../src/lib/workdayRequirements";
import { dailySendProblem, sameCandidateList, EMAIL_RETENTION_MS, type DailyEmailSnapshot } from "../../src/lib/dailyEmail";
import { validateResearchLink, checkResearchSubmission } from "../../src/lib/eod-format";
import { dailyEmailsFor, finalizeDailyEmail, middayRequired } from "../lib/dailyEmail";
import { requiredChecks } from "../lib/workdayChecks";
import { refreshWorkdayChecks } from "./workdays";

type Ctx = QueryCtx | MutationCtx;
const submissionType = v.union(v.literal("midday"), v.literal("eod"));
const fields = v.record(v.string(), v.string());
const worker = (u: Doc<"users">) => ["ta", "ta_support"].includes(mapUser(u).role);

async function access(ctx: Ctx, actorId: string, jobId: Id<"jobs">, readOnly = false) {
  const user = await requireActor(ctx, actorId);
  const role = mapUser(user).role;
  if (!["ta", "ta_support", "ta_lead", "director", "admin", "ops", ...(readOnly ? ["viewer"] : [])].includes(role)) throw new Error("You cannot access recruitment emails.");
  if (!["admin", "ta_lead", "director", "ops"].includes(role)) await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "ta_lead", "director"]);
  const job = await ctx.db.get(jobId);
  if (!job) throw new Error("This opening no longer exists.");
  return user;
}

async function workday(ctx: Ctx, user: Doc<"users">, jobId: Id<"jobs">) {
  const days = await ctx.db.query("taWorkdays").withIndex("by_user", q => q.eq("userId", user._id)).collect();
  const day = days.find(d => d.date === workdayDate(Date.now()) && (d.finishedAt === undefined || d.closureReason === "eod"));
  if (worker(user) && (!day || day.date !== workdayDate(Date.now()) || !day.jobs.some(j => j.jobId === jobId)))
    throw new Error("Start today's workday and add this opening before sending.");
  return day?.date === workdayDate(Date.now()) && day.jobs.some(j => j.jobId === jobId) ? day : null;
}

export const saveAttachment = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), applicationId: v.id("applications"), storageId: v.id("_storage"), name: v.string() },
  handler: async (ctx, args) => {
    const user = await access(ctx, args.actorId, args.jobId);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.jobId !== args.jobId || (worker(user) && app.ownerTaId !== user._id)) throw new Error("This attachment is not on your position.");
    return ctx.db.insert("dailyEmailAttachments", { userId: user._id, jobId: args.jobId, applicationId: args.applicationId,
      storageId: args.storageId, name: args.name, createdAt: Date.now(), expiresAt: Date.now() + EMAIL_RETENTION_MS });
  },
});

export const attachment = internalQuery({
  args: { actorId: v.string(), emailId: v.id("dailyEmails"), attachmentId: v.id("dailyEmailAttachments") },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) throw new Error("Email not found.");
    const user = await access(ctx, args.actorId, email.jobId, true);
    if (worker(user) && email.userId !== user._id) throw new Error("This email belongs to another TA.");
    const snapshot = email.snapshot as DailyEmailSnapshot | undefined;
    if (!snapshot || !email.expiresAt || email.expiresAt <= Date.now() || !snapshot.attachments?.some(a => a.id === args.attachmentId)) throw new Error("This attachment is no longer retained.");
    const file = await ctx.db.get(args.attachmentId);
    if (!file || file.userId !== email.userId || file.jobId !== email.jobId) throw new Error("Attachment not found.");
    return { url: await ctx.storage.getUrl(file.storageId), name: file.name };
  },
});

/** Metadata only: the sidebar does not fetch every rendered email or PDF. */
export const sent = internalQuery({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const emails = await ctx.db.query("dailyEmails").withIndex("by_user_accepted", q => q.eq("userId", user._id).gte("acceptedAt", Date.now() - EMAIL_RETENTION_MS)).collect();
    const saved = await Promise.all(emails.filter(e => e.submissionType === "eod" && e.status === "accepted" && e.finalizedAt && e.snapshot && (e.expiresAt ?? 0) > Date.now()).map(async e => ({
      id: e._id, rootId: e.parentId ?? e._id, jobId: e.jobId, title: (await ctx.db.get(e.jobId))?.title ?? "Unavailable position",
      date: e.date, sentAt: e.acceptedAt!, workType: e.workType ?? e.snapshot.workType, subject: e.snapshot.subject,
      to: e.snapshot.to, cc: e.snapshot.cc, revised: !!e.parentId,
    })));
    const legacy = await ctx.db.query("eodEmailCopies").withIndex("by_expires", q => q.gte("expiresAt", Date.now())).collect();
    const adopted = new Set(emails.map(e => e.legacyCopyId));
    return [...saved, ...await Promise.all(legacy.filter(e => e.sentBy === user._id && e.sentAt >= Date.now() - EMAIL_RETENTION_MS && !adopted.has(e._id)).map(async e => ({
      id: e._id, rootId: e.roundId, jobId: e.openingId, title: (await ctx.db.get(e.openingId))?.title ?? "Unavailable position",
      date: workdayDate(e.sentAt), sentAt: e.sentAt, workType: e.effort?.hundredOrFollowUp,
      subject: e.subject, to: e.to, cc: e.cc, revised: e.version > 1, legacy: true,
    })))];
  },
});

export const list = internalQuery({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await access(ctx, args.actorId, args.jobId, true);
    const rows = await ctx.db.query("dailyEmails").withIndex("by_job", q => q.eq("jobId", args.jobId)).collect();
    return rows.filter(e => !worker(user) || e.userId === user._id).map(e =>
      e.expiresAt && e.expiresAt <= Date.now() ? { ...e, fields: {}, snapshot: undefined } : e);
  },
});

export const createDraft = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await access(ctx, args.actorId, args.jobId);
    await workday(ctx, user, args.jobId);
    const date = workdayDate(Date.now());
    const emails = await dailyEmailsFor(ctx, user._id, args.jobId, date);
    const problem = dailySendProblem(emails, "midday", false);
    if (problem) throw new Error(problem);
    return ctx.db.insert("dailyEmails", { jobId: args.jobId, userId: user._id, date,
      submissionType: "midday", number: Math.max(0, ...emails.filter(e => e.submissionType === "midday").map(e => e.number)) + 1,
      revision: 0, status: "draft", fields: {}, applicationIds: [], createdAt: Date.now(), expiresAt: Date.now() + 31 * 86400000 });
  },
});

export const saveDraft = internalMutation({
  args: { actorId: v.string(), id: v.id("dailyEmails"), revision: v.number(), fields },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.id);
    if (!email) throw new Error("That draft no longer exists.");
    const user = await access(ctx, args.actorId, email.jobId);
    if (email.userId !== user._id || !["draft", "failed"].includes(email.status)) throw new Error("Only your unsent drafts can be edited.");
    if (email.date !== workdayDate(Date.now())) throw new Error("This draft belongs to a previous day. Start today's email.");
    if (email.revision !== args.revision) throw new Error("This draft changed in another tab. Reload before editing it.");
    if (JSON.stringify(args.fields).length > 250000) throw new Error("This draft is too large to save.");
    await ctx.db.patch(email._id, { fields: args.fields, revision: email.revision + 1 });
    return { revision: email.revision + 1 };
  },
});

export const begin = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), submissionType,
    draftId: v.optional(v.id("dailyEmails")), revision: v.optional(v.number()), parentId: v.optional(v.id("dailyEmails")),
    applicationIds: v.array(v.id("applications")), snapshot: v.any(), confirmed: v.boolean(), previewConfirmed: v.optional(v.boolean()), trackedAt: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await access(ctx, args.actorId, args.jobId);
    const source = args.parentId ? await ctx.db.get(args.parentId) : null;
    if (args.parentId && (!source || source.userId !== user._id || source.jobId !== args.jobId || source.submissionType !== "eod" || args.submissionType !== "eod" || source.status !== "accepted" || !source.snapshot || (source.expiresAt ?? 0) <= Date.now()))
      throw new Error("Only your retained EOD emails can be corrected.");
    const parent = source;
    if (parent && !args.previewConfirmed) throw new Error("Review and confirm the revised email preview before sending.");
    const day = parent ? null : await workday(ctx, user, args.jobId);
    const setup = day && args.submissionType === "eod" ? await requiredChecks(ctx, day, day.jobs.find(j => j.jobId === args.jobId)!) : null;
    const date = workdayDate(Date.now());
    const emails = await dailyEmailsFor(ctx, user._id, args.jobId, date);
    // Pending sends on older dates also hold the opening until reconciled.
    const all = await ctx.db.query("dailyEmails").withIndex("by_job", q => q.eq("jobId", args.jobId)).collect();
    if (all.some(e => e.status === "sending" || e.status === "uncertain")) throw new Error("An email on this opening is still sending or needs reconciliation.");
    const problem = dailySendProblem(emails, args.submissionType, worker(user) && await middayRequired(ctx, date), !!parent);
    if (problem) throw new Error(problem);
    const snapshot = args.snapshot as DailyEmailSnapshot;
    const entry = day?.jobs.find(j => j.jobId === args.jobId);
    if (day?.finishedAt !== undefined && entry?.workType === "100%") {
      const already = emails.some(e => e.status === "accepted" && e.submissionType === "eod" && !e.parentId && !e.recoveryReopenedAt);
      if (!already) throw new Error("The workday clock has stopped. Change this unfinished position to Follow-up or Add-on before sending.");
    }
    const selectedMode = parent?.workType ?? parent?.snapshot?.workType ?? entry?.workType ?? "100%";
    if (snapshot.workType && snapshot.workType !== selectedMode) throw new Error("The work type changed. Reload and review the email before sending.");
    snapshot.workType = selectedMode;
    for (const a of snapshot.attachments ?? []) {
      const file = await ctx.db.get(a.id as Id<"dailyEmailAttachments">);
      if (!file || file.userId !== user._id || file.jobId !== args.jobId || file.applicationId !== a.applicationId || !args.applicationIds.includes(file.applicationId)) throw new Error("The saved CV attachment does not belong to this email.");
    }
    const link = validateResearchLink(snapshot.researchLink);
    if (args.submissionType === "midday") {
      if (!link.ok || !args.confirmed) throw new Error(link.ok ? "Confirm your ChatGPT link before sending." : link.reason);
    } else {
      const check = checkResearchSubmission({ role: mapUser(user).role, kind: "director", link: snapshot.researchLink, confirmed: args.confirmed,
        excused: !!setup?.eodChecks.find(c => c.key.startsWith("chatgpt:"))?.exception });
      if (!check.ok) throw new Error(check.reason);
    }
    if (!sameCandidateList(snapshot.rows.map(r => r.applicationId), args.applicationIds)) throw new Error("The email preview does not match its candidate list. Reload before sending.");
    if (!snapshot.subject.trim() || !snapshot.to.length) throw new Error("Add a subject and a recipient.");
    if (parent) {
      if (!sameCandidateList(parent.applicationIds, args.applicationIds) || !parent.applicationIds.every((id, i) => id === args.applicationIds[i])) throw new Error("A correction must keep the original candidates and their order.");
    } else {
      const rounds = await ctx.db.query("reviewRounds").withIndex("by_opening", q => q.eq("openingId", args.jobId)).collect();
      const sent = new Set(rounds.filter(r => r.kind === "director" && !r.recoveryReopenedAt).flatMap(r => r.applicationIds));
      for (const e of all.filter(e => e.status === "accepted" && !e.recoveryReopenedAt)) for (const id of e.applicationIds) sent.add(id);
      const apps = await ctx.db.query("applications").withIndex("by_jobId", q => q.eq("jobId", args.jobId)).collect();
      const entry = day?.jobs.find(j => j.jobId === args.jobId);
      const currentWorkType = entry?.workType ?? "100%";
      const sessionStart = entry ? workSessionStart(entry) : null;
      const eligible = apps.filter(a => !sent.has(a._id) && (
        args.submissionType === "eod"
          ? isEodCandidateEligible({
              stage: a.currentStage,
              ownerTaId: a.ownerTaId,
              isAddOn: a.isAddOn,
              lastStageChangedAt: a.lastStageChangedAt,
            }, { taId: worker(user) ? user._id : null, workType: currentWorkType, sessionStart })
          : a.currentStage === "second_shortlist" && (!worker(user) || a.ownerTaId === user._id)
      ));
      if (!sameCandidateList(args.applicationIds, eligible.map(a => a._id))) throw new Error("The candidate list changed. Reload, review the updated list and send again.");
      if (args.submissionType === "eod" && currentWorkType === "100%" && !args.applicationIds.length)
        throw new Error("Include at least one CV from Director Review before sending the end-of-day email.");
      if (day && args.submissionType === "eod") {
        const blockers = setup!.eodChecks.filter(c => !["director_cv", "chatgpt"].includes(c.key.split(":")[0]) && c.status !== "complete" && !c.exception);
        if (blockers.length) throw new Error(`Complete Today's Checks: ${blockers.map(c => c.label).join("; ")}`);
      }
    }
    // A legacy send still in flight must not be bypassed through the new UI.
    if (day) {
      const receipts = await ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", args.jobId)).collect();
      if (receipts.some(r => ["sending", "uncertain"].includes(r.status) || (r.status === "accepted" && !r.finalizedAt))) throw new Error("An earlier email needs reconciliation before sending.");
      if (!parent && receipts.some(r => r.status === "accepted" && !r.revised && !r.recoveryReopenedAt && (r.submissionType ?? "eod") === "eod")) throw new Error("The end-of-day email has already been sent today.");
    }
    const draft = args.draftId ? await ctx.db.get(args.draftId) : null;
    if (args.draftId && args.submissionType !== "midday") throw new Error("Only a midday email can use this draft.");
    if (args.submissionType === "midday" && (!draft || draft.submissionType !== "midday" || draft.userId !== user._id || draft.jobId !== args.jobId || draft.date !== date || !["draft", "failed"].includes(draft.status) || draft.revision !== args.revision))
      throw new Error("This midday draft changed. Reload it before sending.");
    const now = Date.now();
    const payload = { status: "sending" as const, startedAt: now, snapshot, applicationIds: args.applicationIds,
      trackedAt: args.trackedAt, workType: selectedMode, expiresAt: now + EMAIL_RETENTION_MS };
    const id = draft ? draft._id : await ctx.db.insert("dailyEmails", { jobId: args.jobId, userId: user._id, date: parent?.date ?? date,
      submissionType: "eod", number: 1, revision: 0, fields: {}, createdAt: now,
      ...(parent ? { parentId: parent.parentId ?? parent._id } : {}), ...payload });
    if (draft) await ctx.db.patch(id, { ...payload, revision: draft.revision + 1 });
    if (day) {
      const receiptId = await ctx.db.insert("taWorkdayMail", { workdayId: day._id, userId: user._id, jobId: args.jobId,
        dailyEmailId: id, submissionType: args.submissionType, applicationIds: args.applicationIds,
        workType: selectedMode,
        status: "sending", startedAt: now, subject: snapshot.subject, sentTo: snapshot.to[0], researchLink: snapshot.researchLink });
      await ctx.db.patch(id, { receiptId });
    }
    return { id };
  },
});

export const reconcile = internalMutation({
  args: { actorId: v.string(), id: v.id("dailyEmails"), accepted: v.boolean(), reason: v.string() },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.id);
    if (!email) throw new Error("That email no longer exists.");
    const lead = await access(ctx, args.actorId, email.jobId);
    const job = await ctx.db.get(email.jobId);
    if (mapUser(lead).role !== "admin" && (mapUser(lead).role !== "ta_lead" || job?.taLeadId !== lead._id)) throw new Error("Only this opening's TA Lead can reconcile the email.");
    if (email.finalizedAt || !["sending", "uncertain", "accepted"].includes(email.status)) throw new Error("This email does not need reconciliation.");
    if (!args.reason.trim() || args.reason.length > 1000) throw new Error("Record how you verified the sending mailbox and its message reference.");
    if (email.status === "sending" && Date.now() - (email.startedAt ?? 0) < 300000) throw new Error("Wait five minutes and check the sending mailbox before reconciling.");
    if (email.status === "accepted" && !args.accepted) throw new Error("Microsoft Graph already accepted this email.");
    const patch = { status: args.accepted ? "accepted" as const : "failed" as const,
      ...(args.accepted ? { acceptedAt: email.acceptedAt ?? Date.now() } : {}), reconciledBy: lead._id, reconciliationReason: args.reason.trim() };
    await ctx.db.patch(email._id, patch);
    if (email.receiptId) await ctx.db.patch(email.receiptId, { status: patch.status, reconciledAt: Date.now(), reconciledBy: lead._id, reconciliationReason: args.reason.trim() });
    if (args.accepted) await finalizeDailyEmail(ctx, { ...email, ...patch });
    await refreshWorkdayChecks(ctx, email.jobId, lead._id);
    return { ok: true };
  },
});

export const result = internalMutation({
  args: { id: v.id("dailyEmails"), status: v.union(v.literal("accepted"), v.literal("failed"), v.literal("uncertain")),
    delivered: v.optional(v.object({ from: v.string(), to: v.array(v.string()), cc: v.array(v.string()) })) },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.id);
    if (!email || email.status !== "sending") return;
    const acceptedAt = args.status === "accepted" ? Date.now() : undefined;
    const snapshot = { ...email.snapshot, ...(args.delivered ?? {}) };
    await ctx.db.patch(email._id, { status: args.status, ...(acceptedAt ? { acceptedAt } : {}), snapshot });
    if (email.receiptId) await ctx.db.patch(email.receiptId, { status: args.status, ...(acceptedAt ? { acceptedAt } : {}) });
    if (args.status === "accepted") await finalizeDailyEmail(ctx, { ...email, status: "accepted", acceptedAt, snapshot });
    await refreshWorkdayChecks(ctx, email.jobId, email.userId);
  },
});

/** Release pipeline run_function only. Re-running never moves the rollout date. */
export const enableRequirement = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("dailyEmailPolicy").withIndex("by_key", q => q.eq("key", "midday")).first();
    const requiredFrom = existing?.requiredFrom ?? workdayDate(Date.now() + 86400000);
    if (!args.dryRun && !existing) await ctx.db.insert("dailyEmailPolicy", { key: "midday", requiredFrom });
    return { dryRun: args.dryRun, requiredFrom };
  },
});
