// convex/mailIntake/interviews.ts
//
// interviews@: a TA's invitation to a client's interview moves the candidate
// to Interview; their answer and a cancellation are noted on the application
// (24 October). The candidate is found by the address the invitation went to,
// or the reply came from — never by name alone — and the opening by the
// client the subject names. Reading the subject: lib/interviewMail.ts.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { executeStageTransition } from "../pipeline/pipelineStateMachine";
import { getGraphToken } from "../lib/graphClient";
import { readInterviewMail, roleOverlap, sameClient, type InterviewMail } from "../lib/interviewMail";
import { matchCvFiles } from "../lib/directorReplyAi";

import { INTERVIEW_MAILBOX } from "./model";

/** Past the TA's own work and before Interview: an invitation moves them on. */
const MOVES_TO_INTERVIEW = new Set(["second_shortlist", "director_shortlist", "client_review"]);
const AT_OR_PAST_INTERVIEW = new Set(["interview", "offer", "placed"]);

/** Further along the pipeline is later in this list; a tie goes to the role's words. */
const STAGE_ORDER = ["new_cvs", "matched_candidates", "ta_shortlist", "follow_up", "second_shortlist", "director_shortlist", "client_review", "interview", "offer", "placed"];
const stageRank = (stage?: string) => STAGE_ORDER.indexOf(stage ?? "new_cvs");

/**
 * The candidate's application at the client the subject names.
 *
 * The first version took the first candidate with the address, and of 32
 * invitations found one (24 October): the same person is often on file
 * twice — a new CV in New CVs, the one being put forward further along — or
 * wrote from another address than their CV's. Every record with the address
 * is read, and the application furthest along wins; with no address on file,
 * the subject's name is matched among that client's people in Director
 * review or later — never further back, where a namesake could be anyone.
 */
export const findApplication = internalQuery({
  args: { emails: v.array(v.string()), client: v.string(), role: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const emails = args.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    const found: { app: Doc<"applications">; job: Doc<"jobs">; name: string }[] = [];
    for (const email of emails) {
      for (const candidate of await ctx.db.query("candidates").withIndex("by_email", (q) => q.eq("email", email)).collect()) {
        for (const app of await ctx.db.query("applications").withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id)).collect()) {
          const job = await ctx.db.get(app.jobId);
          if (job && sameClient(args.client, job.clientName ?? "")) found.push({ app, job, name: candidate.fullName ?? email });
        }
      }
    }
    let how = "by address";
    if (found.length === 0 && args.name) {
      const jobs = (await ctx.db.query("jobs").collect()).filter((j) => ["active", "on_hold"].includes(j.status) && sameClient(args.client, j.clientName ?? ""));
      const pool: { applicationId: string; name: string; app: Doc<"applications">; job: Doc<"jobs"> }[] = [];
      for (const job of jobs) {
        for (const app of await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", job._id)).collect()) {
          if (stageRank(app.currentStage) >= stageRank("second_shortlist")) pool.push({ applicationId: app._id, name: app.candidateName ?? "", app, job });
        }
      }
      const { roster } = matchCvFiles([`${args.name}.pdf`], pool);
      if (roster[0]) { found.push({ app: roster[0].app, job: roster[0].job, name: roster[0].name }); how = "by name"; }
    }
    if (found.length === 0) {
      return { found: false as const, note: `No one at ${args.client} has the address ${emails.join(", ") || "(none)"}${args.name ? ` or the name ${args.name}` : ""}.` };
    }
    const score = (x: (typeof found)[number]) => stageRank(x.app.currentStage) * 100 + roleOverlap(args.role, x.job.title ?? "");
    found.sort((a, b) => score(b) - score(a));
    if (found.length > 1 && score(found[0]) === score(found[1]) && found[0].app._id !== found[1].app._id) {
      return { found: false as const, note: `${found[0].name} has more than one opening at ${args.client}; the role "${args.role}" does not tell them apart.` };
    }
    const { app, job, name } = found[0];
    return {
      found: true as const, applicationId: app._id, candidateName: name, how,
      stage: app.currentStage ?? "new_cvs", job: `${job.clientName ?? ""} · ${job.title ?? ""}`,
    };
  },
});

/** The invitation's move, or the note. Each message acts once (its id is on the event). */
export const applyInterviewMail = internalMutation({
  args: {
    applicationId: v.id("applications"),
    kind: v.union(v.literal("invite"), v.literal("cancel"), v.literal("reply")),
    answer: v.optional(v.string()),
    subject: v.string(), fromAddress: v.string(), messageId: v.string(), receivedAt: v.number(),
  },
  handler: async (ctx, a): Promise<{ result: "moved" | "noted" | "already_recorded" | "left"; stage: string }> => {
    const app = await ctx.db.get(a.applicationId);
    if (!app) return { result: "left", stage: "missing" };
    const stage = app.currentStage ?? "new_cvs";
    const marker = `interviews@ ${a.messageId.slice(-40)}`;
    const events = await ctx.db.query("pipelineEvents").withIndex("by_application", (q) => q.eq("applicationId", a.applicationId)).collect();
    if (events.some((e) => e.metadata?.includes(marker))) return { result: "already_recorded", stage };

    if (a.kind === "invite" && MOVES_TO_INTERVIEW.has(stage)) {
      await executeStageTransition(ctx, {
        applicationId: a.applicationId, targetStage: "interview", actorId: "interview-mail",
        reason: `Invited to the client's interview (${a.fromAddress}): ${a.subject.slice(0, 160)}`,
        bypassRoleCheck: true, skipAutoOutreach: true, decidedByReviewer: true,
      });
      // The move's own event carries the marker, so the invitation is not read twice.
      const moved = await ctx.db.query("pipelineEvents").withIndex("by_application_time", (q) => q.eq("applicationId", a.applicationId)).order("desc").first();
      if (moved) await ctx.db.patch(moved._id, { metadata: JSON.stringify({ source: marker }) });
      return { result: "moved", stage: "interview" };
    }
    const what = a.kind === "invite"
      ? `Invited to the client's interview, but they are at ${stage}, so they were not moved`
      : a.kind === "cancel" ? "The client interview was cancelled"
      : a.answer === "declined" ? "Candidate declined the client interview"
      : a.answer === "confirmed" ? "Candidate confirmed the client interview"
      : "Candidate replied about the client interview";
    await ctx.db.insert("pipelineEvents", {
      applicationId: a.applicationId, candidateId: app.candidateId, jobId: app.jobId,
      eventType: "interview_mail", actorType: "system", actorAgent: "interview-mail",
      notes: `${what} — ${a.subject.slice(0, 160)}`,
      metadata: JSON.stringify({ source: marker, kind: a.kind, answer: a.answer ?? null, receivedAt: a.receivedAt }),
      createdAt: Date.now(),
    });
    return { result: a.kind === "invite" && !AT_OR_PAST_INTERVIEW.has(stage) ? "left" : "noted", stage };
  },
});

export type InterviewRow = Record<string, unknown> & { result: string };

/** One interviews@ message, read and (unless a dry run) acted on. */
export async function handleInterviewMail(
  ctx: ActionCtx,
  m: { messageId: string; subject: string; fromAddress: string; to: string[]; body: string; receivedAt: number },
  dryRun: boolean,
): Promise<InterviewRow & { mail: InterviewMail }> {
  const mail = readInterviewMail(m);
  const base = { receivedAt: new Date(m.receivedAt).toISOString(), from: m.fromAddress, subject: m.subject, kind: mail.kind, answer: mail.answer, mail };
  if (mail.kind === "ignore") return { ...base, result: "ignored", note: mail.why };
  const emails = mail.kind === "reply" ? [m.fromAddress] : m.to.filter((t) => !t.toLowerCase().endsWith("@career141.com"));
  const found = await ctx.runQuery(internal.mailIntake.interviews.findApplication, { emails, client: mail.client, role: mail.role, name: mail.candidate });
  if (!found.found) return { ...base, result: "unmatched", note: found.note };
  const who = { candidate: found.candidateName, job: found.job, stage: found.stage, matched: found.how };
  if (dryRun) {
    const result = mail.kind !== "invite" ? "would_note"
      : MOVES_TO_INTERVIEW.has(found.stage) ? "would_move"
      : AT_OR_PAST_INTERVIEW.has(found.stage) ? "would_note" : "would_leave";
    return { ...base, ...who, result };
  }
  const r = await ctx.runMutation(internal.mailIntake.interviews.applyInterviewMail, {
    applicationId: found.applicationId, kind: mail.kind, answer: mail.answer,
    subject: m.subject, fromAddress: m.fromAddress, messageId: m.messageId, receivedAt: m.receivedAt,
  });
  return { ...base, ...who, result: r.result };
}

/** The live reader's call (mailIntake/process.ts) — through here, so it does not load the state machine itself. */
export const readOne = internalAction({
  args: { messageId: v.string(), subject: v.string(), fromAddress: v.string(), to: v.array(v.string()), body: v.string(), receivedAt: v.number() },
  handler: async (ctx, a): Promise<InterviewRow> => {
    const { mail: _mail, ...row } = await handleInterviewMail(ctx, a, false);
    return row;
  },
});

/**
 * interviews@ mail from before the mailbox was read (24 October): every
 * invitation, answer and cancellation of the last `days`, oldest first.
 * Pipeline-only; `dryRun` is required. Like the shortlist catch-up, no
 * message is started after four minutes and a real run continues in a fresh
 * one, which skips what this one recorded.
 */
export const reconcileInterviews = internalAction({
  args: { dryRun: v.boolean(), days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const deadline = Date.now() + 4 * 60_000;
    const days = Math.min(Math.max(Math.floor(args.days ?? 15), 1), 60);
    const box = await ctx.runQuery(internal.mailIntake.model.mailbox, { mailbox: INTERVIEW_MAILBOX });
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const until = new Date(box?.enabled ? box.backfillFrom : Date.now()).toISOString();
    const token = await getGraphToken();
    type M = {
      id: string; subject?: string; receivedDateTime?: string; bodyPreview?: string;
      from?: { emailAddress?: { address?: string } }; toRecipients?: { emailAddress?: { address?: string } }[];
    };
    const listed: M[] = [];
    let url: string | undefined =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(INTERVIEW_MAILBOX)}/mailFolders/inbox/messages` +
      `?$filter=receivedDateTime ge ${since} and receivedDateTime lt ${until}` +
      `&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview&$top=200`;
    for (let page = 0; url && page < 20; page++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`interviews@ could not be listed: Graph ${response.status} ${(await response.text()).slice(0, 200)}`);
      const data = await response.json() as { value?: M[]; "@odata.nextLink"?: string };
      listed.push(...(data.value ?? []));
      url = data["@odata.nextLink"];
    }
    listed.sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
    const rows: InterviewRow[] = [];
    let notReached = 0;
    for (const m of listed) {
      if (Date.now() > deadline) { notReached++; continue; }
      try {
        const { mail: _mail, ...row } = await handleInterviewMail(ctx, {
          messageId: m.id, subject: m.subject ?? "",
          fromAddress: (m.from?.emailAddress?.address ?? "").toLowerCase(),
          to: (m.toRecipients ?? []).map((r) => (r.emailAddress?.address ?? "").toLowerCase()),
          body: m.bodyPreview ?? "",
          receivedAt: Date.parse(m.receivedDateTime ?? new Date().toISOString()),
        }, args.dryRun);
        rows.push(row);
      } catch (e) {
        rows.push({ subject: m.subject ?? "", result: "error", error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    if (notReached && !args.dryRun) await ctx.scheduler.runAfter(0, internal.mailIntake.interviews.reconcileInterviews, args);
    const summary: Record<string, number> = {};
    for (const row of rows) summary[`${row.kind ?? "?"}: ${row.result}`] = (summary[`${row.kind ?? "?"}: ${row.result}`] ?? 0) + 1;
    if (notReached) summary[args.dryRun ? "not reached (time)" : "continued in a new run"] = notReached;
    console.log(`reconcileInterviews ${args.dryRun ? "dry run" : "run"}: ${JSON.stringify(summary)}`);
    // Ignored mail is counted, not listed — most of the mailbox is Career141's own hiring.
    return { dryRun: args.dryRun, days, listed: listed.length, summary, rows: rows.filter((r) => r.result !== "ignored") };
  },
});

