// convex/mailIntake/aiReader.ts
//
// The model's reading of a Director reply against the set it answers, and
// finding that set when the system has no round for it — the TA emailed it
// from Outlook (23 October). The prompt and every check of the answer are in
// lib/directorReplyAi.ts; this file only calls out.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getModelForTask, getOpenAI } from "../lib/llm";
import { getGraphToken } from "../lib/graphClient";
import { directorReplyPrompt, isCvFile, matchCvFiles, readAiAnswer, type AiReading } from "../lib/directorReplyAi";
import { DIRECTOR_MAILBOXES } from "../lib/shortlistMail";
import { stripReplyPrefixes } from "../lib/shortlistReply";

const rosterArg = v.array(v.object({ applicationId: v.string(), name: v.string() }));

export const readDirectorReply = internalAction({
  args: { text: v.string(), roster: rosterArg, reviewer: v.optional(v.union(v.literal("director"), v.literal("client"))) },
  handler: async (_ctx, args): Promise<AiReading> => {
    if (args.roster.length === 0) return { decisions: [], clear: false, problems: ["There is no set to read the reply against."] };
    try {
      const openai = getOpenAI("shortlist_reply", 45_000);
      const res = await openai.chat.completions.create({
        model: getModelForTask("shortlist_reply"),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: directorReplyPrompt(args.roster, args.text, args.reviewer ?? "director") }],
      });
      return readAiAnswer(res.choices[0]?.message?.content ?? "", args.roster);
    } catch (e) {
      return { decisions: [], clear: false, problems: [`The AI reader could not be reached: ${String((e as Error)?.message ?? e).slice(0, 160)}`] };
    }
  },
});

const SHORTLISTS = "shortlists@career141.com";
const JOBORDERS = "joborders@career141.com";
const lower = (s?: string | null) => (s ?? "").trim().toLowerCase();

/** The TA's applications on their open openings — the people a set of theirs can hold. */
export const taCandidates = internalQuery({
  args: { address: v.string() },
  handler: async (ctx, { address }) => {
    const user = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", address)).first()
      ?? (await ctx.db.query("users").collect()).find((u) => lower(u.email) === lower(address));
    if (!user) return { taId: null as string | null, candidates: [] as { applicationId: string; name: string; jobId: string; stage: string }[] };
    const jobs = (await ctx.db.query("jobs").collect()).filter((j: Doc<"jobs">) =>
      ["active", "on_hold"].includes(j.status) && ((j.assignedTaIds ?? []).includes(user._id) || j.primaryRecruiterId === user._id));
    const candidates = [];
    for (const job of jobs) {
      for (const a of await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", job._id)).collect()) {
        if (a.ownerTaId !== user._id && a.currentStage !== "second_shortlist") continue;
        candidates.push({ applicationId: a._id as string, name: a.candidateName ?? "", jobId: job._id as string, stage: a.currentStage });
      }
    }
    return { taId: user._id as string, candidates };
  },
});

/** People a client set can hold: on any open opening, past the TA's own work. */
export const clientCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: { applicationId: string; name: string; jobId: string; stage: string }[] = [];
    for (const job of (await ctx.db.query("jobs").collect()).filter((j: Doc<"jobs">) => ["active", "on_hold"].includes(j.status))) {
      for (const stage of ["second_shortlist", "director_shortlist", "client_review", "interview"] as const) {
        for (const a of await ctx.db.query("applications").withIndex("by_job_stage", (q) => q.eq("jobId", job._id).eq("currentStage", stage)).collect()) {
          out.push({ applicationId: a._id as string, name: a.candidateName ?? "", jobId: job._id as string, stage: a.currentStage });
        }
      }
    }
    return out;
  },
});

/**
 * The set a reply answers when no round recorded it: the TA's latest email
 * with CVs in the same thread before the reply — in shortlists@, or in
 * joborders@ where every set goes — its CV file names matched to that TA's
 * candidates, on the opening most of them belong to.
 */
export const findSetInThread = internalAction({
  args: {
    conversationId: v.optional(v.string()), subject: v.string(), before: v.number(),
    /** A client's reply: the set is the email sent to that client, by whoever at Career141 sent it. */
    clientAddress: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    found: boolean; note: string; openingId?: string; sentBy?: string; sentAt?: number; subject?: string;
    messageId?: string; conversationId?: string; sentTo?: string;
    roster: { applicationId: string; name: string; stage: string }[]; unmatched: string[];
  }> => {
    const token = await getGraphToken();
    if (!token) return { found: false, note: "Microsoft Graph is not configured.", roster: [], unmatched: [] };
    const H = { Authorization: `Bearer ${token}` };
    const directors = new Set<string>(DIRECTOR_MAILBOXES);
    type M = {
      id: string; subject?: string; receivedDateTime?: string; hasAttachments?: boolean; conversationId?: string;
      from?: { emailAddress?: { address?: string } }; toRecipients?: { emailAddress?: { address?: string } }[];
    };
    const clientDomain = args.clientAddress ? lower(args.clientAddress).split("@")[1] : null;
    const looks = (m: M) => {
      const from = lower(m.from?.emailAddress?.address);
      if (!m.hasAttachments || !from.endsWith("@career141.com") || Date.parse(m.receivedDateTime ?? "") > args.before) return false;
      // A Director set is the TA's; a client set is the one addressed to that client's company.
      if (!clientDomain) return !directors.has(from);
      return (m.toRecipients ?? []).some((r) => lower(r.emailAddress?.address).endsWith(`@${clientDomain}`));
    };
    const subject = stripReplyPrefixes(args.subject).replace(/'/g, "''");
    let email: (M & { box: string }) | null = null;
    for (const box of [SHORTLISTS, JOBORDERS]) {
      const filters = [
        ...(args.conversationId ? [`conversationId eq '${args.conversationId.replace(/'/g, "''")}'`] : []),
        `subject eq '${subject}'`,
      ];
      for (const filter of filters) {
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(box)}/messages?$filter=${encodeURIComponent(filter)}&$select=id,subject,from,toRecipients,receivedDateTime,hasAttachments,conversationId&$top=50`;
        const res = await fetch(url, { headers: H });
        if (!res.ok) continue;
        const hits = ((await res.json()).value ?? []) as M[];
        const best = hits.filter(looks).sort((a, b) => (b.receivedDateTime ?? "").localeCompare(a.receivedDateTime ?? ""))[0];
        if (best) { email = { ...best, box }; break; }
      }
      if (email) break;
    }
    if (!email) return { found: false, note: "The TA's email with the CVs was not found in shortlists@ or joborders@.", roster: [], unmatched: [] };

    const att = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email.box)}/messages/${encodeURIComponent(email.id)}/attachments?$select=name`, { headers: H });
    const files = att.ok ? (((await att.json()).value ?? []) as { name?: string }[]).map((a) => a.name ?? "").filter(isCvFile) : [];
    if (!files.length) return { found: false, note: "The TA's email in this thread carries no CVs.", roster: [], unmatched: [] };

    const from = lower(email.from?.emailAddress?.address);
    const sentTo = clientDomain
      ? lower((email.toRecipients ?? []).map((r) => r.emailAddress?.address).find((a) => lower(a).endsWith(`@${clientDomain}`)))
      : JOBORDERS;
    const mine = await ctx.runQuery(internal.mailIntake.aiReader.taCandidates, { address: from });
    const taId = mine.taId;
    const candidates = clientDomain ? await ctx.runQuery(internal.mailIntake.aiReader.clientCandidates, {}) : mine.candidates;
    if (!taId) return { found: false, note: `${from} is not a user in the system.`, roster: [], unmatched: [] };
    // The opening most of the CVs belong to.
    const byJob = new Map<string, typeof candidates>();
    for (const c of candidates) byJob.set(c.jobId, [...(byJob.get(c.jobId) ?? []), c]);
    let best: { jobId: string; roster: typeof candidates; unmatched: string[] } | null = null;
    for (const [jobId, list] of byJob) {
      const m = matchCvFiles(files, list);
      if (!best || m.roster.length > best.roster.length) best = { jobId, roster: m.roster, unmatched: m.unmatched };
    }
    if (!best || best.roster.length === 0) return { found: false, note: "None of the CVs in the TA's email match a candidate on their openings.", roster: [], unmatched: files };
    return {
      found: true,
      note: `Set rebuilt from ${from}'s email in ${email.box}: ${best.roster.length} of ${files.length} CVs matched.`,
      openingId: best.jobId, sentBy: taId, sentAt: Date.parse(email.receivedDateTime ?? ""), subject: email.subject ?? args.subject,
      messageId: email.id, conversationId: email.conversationId ?? args.conversationId, sentTo,
      roster: best.roster.map((r) => ({ applicationId: r.applicationId, name: r.name, stage: r.stage })), unmatched: best.unmatched,
    };
  },
});

/** A round for a set the TA emailed outside the system, so its reply can be applied like any other. */
export const createRoundFromThread = internalMutation({
  args: {
    openingId: v.id("jobs"), sentBy: v.id("users"), sentAt: v.number(), subject: v.string(),
    messageId: v.string(), conversationId: v.optional(v.string()), applicationIds: v.array(v.id("applications")),
    kind: v.optional(v.union(v.literal("director"), v.literal("client"))),
    sentTo: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Id<"reviewRounds">> => {
    const token = `C141-THREAD-${a.messageId.slice(-40)}`;
    const existing = await ctx.db.query("reviewRounds").withIndex("by_token", (q) => q.eq("token", token)).first();
    if (existing) return existing._id;
    return ctx.db.insert("reviewRounds", {
      openingId: a.openingId, kind: a.kind ?? "director", token, applicationIds: a.applicationIds,
      sentBy: a.sentBy, sentAt: a.sentAt, sentTo: a.sentTo || JOBORDERS, subject: a.subject,
      messageId: a.messageId, conversationId: a.conversationId ?? null,
      dispatch: "sent", status: "awaiting", decisions: [],
    });
  },
});
