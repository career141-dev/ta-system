// Durable shortlist decision queue. No mailbox state is changed here: Graph is
// read-only, and every candidate move is written through the pipeline state
// machine with the source email kept as evidence.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { executeStageTransition, type PipelineStage } from "../pipeline/pipelineStateMachine";
import {
  matchReplyRound, newestReplyText, parseShortlistReply, placement, SHORTLIST_STAGE,
  type ReplyDecision, type ReplyRound,
} from "../lib/shortlistReply";
import { resolveActor } from "../lib/auth";
import { toTaStage } from "../ta/stages";
import { getGraphToken } from "../lib/graphClient";
import { DIRECTOR_MAILBOXES } from "../lib/shortlistMail";

const decisionValidator = v.object({
  applicationId: v.id("applications"),
  outcome: v.union(v.literal("shortlisted"), v.literal("rejected"), v.literal("hold")),
  evidence: v.string(),
});

function deskRole(user: Doc<"users">): string {
  if (user.taRole) return user.taRole;
  if (user.role === "ta_manager" || user.role === "senior_ta") return "ta_lead";
  if (user.role === "recruiter") return "ta";
  return user.role;
}

function requireReviewer(user: Doc<"users">): void {
  if (!["admin", "director", "ta_lead", "ops"].includes(deskRole(user))) {
    throw new Error("Only Admin, Director, TA Lead or Ops can review shortlist replies.");
  }
}

const normalAddress = (value?: string | null) => (value ?? "").trim().toLowerCase();

type DecisionContext = ReplyRound & {
  openingId: string;
  kind: "director" | "client";
  sentAt: number;
  sentBy: string;
  senderAuthorized: boolean;
  openingTitle: string;
  clientName: string;
  taLeadId?: string;
  roster: { applicationId: string; candidateId?: string; name: string; stage: string }[];
};

export const context = internalQuery({
  args: { fromAddress: v.string() },
  handler: async (ctx, args): Promise<DecisionContext[]> => {
    const rounds = (await ctx.db.query("reviewRounds").collect()).filter((round) => round.status !== "returned");
    const users = await ctx.db.query("users").collect();
    const directorAddresses = new Set([...DIRECTOR_MAILBOXES, ...users
      .filter((user) => user.isActive && deskRole(user) === "director")
      .flatMap((user) => [normalAddress(user.email), normalAddress(user.routingEmail)])
      .filter(Boolean)]);
    const out: DecisionContext[] = [];
    for (const round of rounds) {
      const job = await ctx.db.get(round.openingId);
      const roster = [];
      for (const applicationId of round.applicationIds) {
        const application = await ctx.db.get(applicationId);
        const candidate = application ? await ctx.db.get(application.candidateId) : null;
        roster.push({
          applicationId: applicationId as string,
          candidateId: application?.candidateId as string | undefined,
          name: candidate?.fullName ?? application?.candidateName ?? "Unknown candidate",
          stage: application?.currentStage ?? "missing",
        });
      }
      const senderAuthorized = round.kind === "director"
        ? directorAddresses.has(normalAddress(args.fromAddress))
        : normalAddress(job?.clientContactEmail) === normalAddress(args.fromAddress);
      out.push({
        id: round._id as string,
        openingId: round.openingId as string,
        kind: round.kind,
        token: round.token,
        subject: round.subject,
        status: round.status,
        sentAt: round.sentAt,
        sentBy: round.sentBy as string,
        conversationId: round.conversationId ?? null,
        internetMessageId: round.internetMessageId ?? null,
        messageId: round.messageId ?? null,
        senderAuthorized,
        openingTitle: job?.title ?? "Unknown opening",
        clientName: job?.clientName ?? "Unknown client",
        taLeadId: job?.taLeadId as string | undefined,
        roster,
      });
    }
    return out;
  },
});

export const existing = internalQuery({
  args: { sourceMessageId: v.id("mailIntakeMessages") },
  handler: async (ctx, args) => ctx.db.query("shortlistDecisionReviews")
    .withIndex("by_source_message", (q) => q.eq("sourceMessageId", args.sourceMessageId)).first(),
});

/** The copy of the original email received at shortlists@ teaches the round its Graph thread. */
export const attachRoundTransport = internalMutation({
  args: {
    token: v.optional(v.string()),
    subject: v.string(),
    fromAddress: v.string(),
    receivedAt: v.number(),
    conversationId: v.optional(v.string()),
    internetMessageId: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let round = args.token
      ? await ctx.db.query("reviewRounds").withIndex("by_token", (q) => q.eq("token", args.token!)).first()
      : null;
    if (!round) {
      const subject = args.subject.trim().replace(/\s+/g, " ").toLowerCase();
      const candidates = [];
      for (const candidate of (await ctx.db.query("reviewRounds").collect()).filter((row) => row.status !== "returned")) {
        if (candidate.subject.trim().replace(/\s+/g, " ").toLowerCase() !== subject) continue;
        if (Math.abs(args.receivedAt - candidate.sentAt) > 60 * 60 * 1000) continue;
        const sender = await ctx.db.get(candidate.sentBy);
        const addresses = [normalAddress(sender?.email), normalAddress(sender?.routingEmail)].filter(Boolean);
        if (addresses.includes(normalAddress(args.fromAddress))) candidates.push(candidate);
      }
      if (candidates.length === 1) round = candidates[0];
    }
    if (!round) return { attached: false };
    const sender = await ctx.db.get(round.sentBy);
    await ctx.db.patch(round._id, {
      conversationId: round.conversationId ?? args.conversationId,
      internetMessageId: round.internetMessageId ?? args.internetMessageId,
      messageId: round.messageId ?? args.messageId,
    });
    const isRoundMessage = Boolean(
      (args.internetMessageId && round.internetMessageId === args.internetMessageId)
      || (args.messageId && round.messageId === args.messageId)
      || (!round.internetMessageId && !round.messageId),
    );
    return {
      attached: true,
      roundId: round._id,
      isRoundMessage,
      subject: round.subject,
      sentAt: round.sentAt,
      senderAddresses: [normalAddress(sender?.email), normalAddress(sender?.routingEmail)].filter(Boolean),
    };
  },
});

export const createReview = internalMutation({
  args: {
    sourceMessageId: v.id("mailIntakeMessages"), graphMessageId: v.string(),
    conversationId: v.optional(v.string()), internetMessageId: v.optional(v.string()), inReplyTo: v.optional(v.string()),
    receivedAt: v.number(), fromAddress: v.string(), subject: v.string(), replyText: v.string(),
    roundId: v.optional(v.id("reviewRounds")), openingId: v.optional(v.id("jobs")),
    matchMethod: v.union(v.literal("conversation"), v.literal("reply_header"), v.literal("token"), v.literal("subject"), v.literal("none")),
    matchNote: v.string(), senderAuthorized: v.boolean(), decisions: v.array(decisionValidator),
    reviewReasons: v.array(v.string()), historical: v.boolean(),
  },
  handler: async (ctx, args) => {
    const prior = await ctx.db.query("shortlistDecisionReviews")
      .withIndex("by_source_message", (q) => q.eq("sourceMessageId", args.sourceMessageId)).first();
    if (prior) return prior._id;
    return ctx.db.insert("shortlistDecisionReviews", { ...args, status: "pending", createdAt: Date.now() });
  },
});

type ApplyResult = {
  moved: number; rejected: number; held: number; stale: number;
  /** Recorded, not moved: they were already where the decision puts them. */
  already: number;
  /** Taken off a shortlist they were moved onto before the reviewer said no. */
  corrected: number;
  /** Recorded, not moved, for a person to settle. */
  left: { applicationId: string; stage: string; outcome: string }[];
};

async function apply(ctx: MutationCtx, review: Doc<"shortlistDecisionReviews">, decisions: ReplyDecision[], confirmed: boolean, actorId?: Id<"users">): Promise<ApplyResult> {
  const result: ApplyResult = { moved: 0, rejected: 0, held: 0, stale: 0, already: 0, corrected: 0, left: [] };
  if (!review.roundId) return { ...result, stale: decisions.length };
  const round = await ctx.db.get(review.roundId);
  if (!round) return { ...result, stale: decisions.length };
  const existing = new Map(round.decisions.map((decision) => [decision.applicationId as string, decision]));
  const accepted: typeof round.decisions = [];
  const who = round.kind === "director" ? "Director" : "Client";
  for (const decision of decisions) {
    const applicationId = decision.applicationId as Id<"applications">;
    if (!round.applicationIds.includes(applicationId)) { result.stale++; continue; }
    if (decision.outcome === "hold") {
      result.held++;
      accepted.push({ applicationId, outcome: "hold", note: decision.evidence || null, confirmed });
      continue;
    }
    const application = await ctx.db.get(applicationId);
    if (!application) { result.stale++; continue; }
    // The reviewer's decision is recorded whatever happens to the stage: it is
    // what they said, and the reports read it (22 Oct).
    accepted.push({ applicationId, outcome: decision.outcome, note: decision.evidence || null, confirmed });
    const how = placement(round.kind, application.currentStage, decision.outcome, confirmed);
    if (how === "already") { result.already++; continue; }
    if (how === "left") {
      result.left.push({ applicationId, stage: application.currentStage, outcome: decision.outcome });
      continue;
    }
    const target = decision.outcome === "shortlisted" ? SHORTLIST_STAGE[round.kind] : "rejected";
    await executeStageTransition(ctx, {
      applicationId,
      targetStage: target as PipelineStage,
      actorId: actorId ?? "shortlist-mail",
      reason: how === "correct"
        ? `Corrected: the ${who}'s reply from ${review.fromAddress} says not selected, after they had been moved to the shortlist: ${decision.evidence.slice(0, 160)}`
        : `${who} decision from ${review.fromAddress}: ${decision.evidence.slice(0, 180)}`,
      bypassRoleCheck: true,
      skipAutoOutreach: true,
      decidedByReviewer: true,
    });
    if (how === "correct") result.corrected++;
    else if (decision.outcome === "shortlisted") result.moved++;
    else result.rejected++;
  }
  for (const decision of accepted) existing.set(decision.applicationId as string, decision);
  const merged = [...existing.values()];
  await ctx.db.patch(round._id, {
    decisions: merged,
    replyBody: [round.replyBody, review.replyText].filter(Boolean).join("\n\n---\n\n") || null,
    returnedAt: Date.now(),
    status: merged.filter((decision) => decision.outcome !== "hold").length >= round.applicationIds.length ? "returned" : "partial",
  });
  return result;
}

export const applyAutomatic = internalMutation({
  args: { reviewId: v.id("shortlistDecisionReviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review || review.status !== "pending") return { moved: 0, rejected: 0, held: 0, stale: 0, already: 0, corrected: 0, left: [] };
    const result = await apply(ctx, review, review.decisions, false);
    await ctx.db.patch(review._id, { status: "auto_applied", appliedAt: Date.now() });
    return result;
  },
});

export const requireReview = internalMutation({
  args: { reviewId: v.id("shortlistDecisionReviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (review?.status === "pending") await ctx.db.patch(review._id, { status: "review_required" });
    return { ok: Boolean(review) };
  },
});

export const processReply = internalAction({
  args: {
    sourceMessageId: v.id("mailIntakeMessages"), graphMessageId: v.string(),
    conversationId: v.optional(v.string()), internetMessageId: v.optional(v.string()), inReplyTo: v.optional(v.string()),
    receivedAt: v.number(), fromAddress: v.string(), subject: v.string(), body: v.string(),
    historical: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ reviewId: string; status: "auto_applied" | "review_required"; note: string; openingId?: string; candidateIds: string[] }> => {
    const prior = await ctx.runQuery(internal.mailIntake.decisions.existing, { sourceMessageId: args.sourceMessageId });
    if (prior) return {
      reviewId: prior._id as string,
      status: prior.status === "auto_applied" ? "auto_applied" : "review_required",
      note: "This message already has a shortlist decision record.",
      openingId: prior.openingId as string | undefined,
      candidateIds: [],
    };
    const contexts: DecisionContext[] = await ctx.runQuery(internal.mailIntake.decisions.context, { fromAddress: args.fromAddress });
    const matched = matchReplyRound(args, contexts as ReplyRound[]);
    const chosen = matched.round ? contexts.find((round) => round.id === matched.round!.id) : null;
    const parsed = parseShortlistReply(args.body, chosen?.roster ?? []);
    const reviewReasons = [...parsed.reviewReasons];
    if (!chosen) reviewReasons.push(matched.note);
    if (chosen && !chosen.senderAuthorized) reviewReasons.push("The sender is not the recorded Director or client contact.");
    if (matched.method === "subject") reviewReasons.push("This legacy reply matched only by subject and needs confirmation.");
    // Anybody the reply would leave where they are, or would take back off a
    // shortlist, is for a person: an automatic read never undoes a move.
    for (const decision of chosen ? parsed.decisions : []) {
      const row = chosen!.roster.find((candidate) => candidate.applicationId === decision.applicationId);
      if (!row) continue;
      const how = placement(chosen!.kind, row.stage, decision.outcome, false);
      if (how === "left" && decision.outcome === "rejected" && row.stage === SHORTLIST_STAGE[chosen!.kind]) {
        reviewReasons.push(`${row.name} is already in ${chosen!.kind === "director" ? "Director" : "Client"} Shortlist, but the reply says not selected. Confirm to take them off.`);
      } else if (how === "left") {
        reviewReasons.push(`${row.name} is at ${toTaStage(row.stage).replace(/_/g, " ")}, so the reply's ${decision.outcome === "rejected" ? "not selected" : decision.outcome} is not applied there.`);
      }
    }
    const decisions = parsed.decisions.map((decision) => ({ ...decision, applicationId: decision.applicationId as Id<"applications"> }));
    const reviewId = await ctx.runMutation(internal.mailIntake.decisions.createReview, {
      sourceMessageId: args.sourceMessageId, graphMessageId: args.graphMessageId,
      conversationId: args.conversationId, internetMessageId: args.internetMessageId, inReplyTo: args.inReplyTo,
      receivedAt: args.receivedAt, fromAddress: args.fromAddress, subject: args.subject,
      replyText: args.body.slice(0, 20_000), roundId: chosen?.id as Id<"reviewRounds"> | undefined,
      openingId: chosen?.openingId as Id<"jobs"> | undefined, matchMethod: matched.method,
      matchNote: matched.note, senderAuthorized: chosen?.senderAuthorized ?? false,
      decisions, reviewReasons: [...new Set(reviewReasons)], historical: args.historical ?? false,
    });
    const automatic = process.env.C141_SHORTLIST_AUTO_APPLY === "on"
      && !args.historical && Boolean(chosen?.senderAuthorized) && parsed.autoSafe
      && reviewReasons.length === 0
      && matched.method !== "none" && matched.method !== "subject";
    if (automatic) {
      const result: ApplyResult = await ctx.runMutation(internal.mailIntake.decisions.applyAutomatic, { reviewId });
      return { reviewId: reviewId as string, status: "auto_applied", note: `${result.moved} shortlisted, ${result.rejected} rejected; ${result.stale} stale.`, openingId: chosen?.openingId, candidateIds: chosen?.roster.map((row) => row.candidateId).filter(Boolean) as string[] ?? [] };
    }
    await ctx.runMutation(internal.mailIntake.decisions.requireReview, { reviewId });
    if (chosen) {
      for (const userId of [...new Set([chosen.sentBy, chosen.taLeadId].filter((id): id is string => Boolean(id)))]) {
        await ctx.runMutation(internal.ta.notifications.create, {
          userId, type: "candidate_replied", title: "Shortlist reply needs review",
          body: `${chosen.clientName} · ${chosen.openingTitle}: ${matched.note}`,
          jobId: chosen.openingId,
        });
      }
    }
    return { reviewId: reviewId as string, status: "review_required", note: [...new Set(reviewReasons)].join(" ") || "Check the proposed decisions.", openingId: chosen?.openingId, candidateIds: chosen?.roster.map((row) => row.candidateId).filter(Boolean) as string[] ?? [] };
  },
});

export const list = internalQuery({
  args: { actorId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await resolveActor(ctx, args.actorId);
    requireReviewer(user);
    const rows = await ctx.db.query("shortlistDecisionReviews").order("desc").take(Math.min(args.limit ?? 100, 200));
    const items = [];
    for (const row of rows) {
      const round = row.roundId ? await ctx.db.get(row.roundId) : null;
      const job = row.openingId ? await ctx.db.get(row.openingId) : null;
      const roster = [];
      for (const applicationId of round?.applicationIds ?? []) {
        const application = await ctx.db.get(applicationId);
        const candidate = application ? await ctx.db.get(application.candidateId) : null;
        roster.push({ applicationId: applicationId as string, name: candidate?.fullName ?? application?.candidateName ?? "Unknown candidate", stage: application?.currentStage ?? "missing" });
      }
      items.push({ ...row, id: row._id as string, roundId: row.roundId as string | undefined, openingId: row.openingId as string | undefined, openingTitle: job?.title ?? null, clientName: job?.clientName ?? null, roster });
    }
    const openRounds = (await ctx.db.query("reviewRounds").collect()).filter((round) => round.status !== "returned");
    const roundOptions = [];
    for (const round of openRounds) {
      const job = await ctx.db.get(round.openingId);
      roundOptions.push({ id: round._id as string, openingId: round.openingId as string, label: `${job?.clientName ?? "Unknown"} · ${job?.title ?? "Unknown"} · ${round.kind} · ${new Date(round.sentAt).toLocaleDateString("en-GB")}` });
    }
    return { items, roundOptions };
  },
});

export const rematch = internalMutation({
  args: { actorId: v.id("users"), reviewId: v.id("shortlistDecisionReviews"), roundId: v.id("reviewRounds") },
  handler: async (ctx, args) => {
    const { user } = await resolveActor(ctx, args.actorId); requireReviewer(user);
    const review = await ctx.db.get(args.reviewId); const round = await ctx.db.get(args.roundId);
    if (!review || !round || ["confirmed", "ignored", "auto_applied"].includes(review.status)) throw new Error("That reply can no longer be rematched.");
    const roster = [];
    for (const applicationId of round.applicationIds) {
      const application = await ctx.db.get(applicationId); const candidate = application ? await ctx.db.get(application.candidateId) : null;
      roster.push({ applicationId: applicationId as string, name: candidate?.fullName ?? application?.candidateName ?? "Unknown candidate" });
    }
    const parsed = parseShortlistReply(review.replyText, roster);
    await ctx.db.patch(review._id, { roundId: round._id, openingId: round.openingId, matchMethod: "none", matchNote: `Matched manually by ${user.fullName}.`, decisions: parsed.decisions.map((decision) => ({ ...decision, applicationId: decision.applicationId as Id<"applications"> })), reviewReasons: parsed.reviewReasons });
    return { ok: true };
  },
});

export const confirm = internalMutation({
  args: { actorId: v.id("users"), reviewId: v.id("shortlistDecisionReviews"), decisions: v.array(decisionValidator), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await resolveActor(ctx, args.actorId); requireReviewer(user);
    const review = await ctx.db.get(args.reviewId);
    if (!review || ["confirmed", "ignored", "auto_applied"].includes(review.status)) throw new Error("That reply has already been completed.");
    if (!review.roundId) throw new Error("Choose the correct review round first.");
    const result = await apply(ctx, review, args.decisions, true, user._id);
    await ctx.db.patch(review._id, { status: "confirmed", appliedAt: Date.now(), reviewedAt: Date.now(), reviewedBy: user._id, reviewNote: args.note?.slice(0, 500) });
    return result;
  },
});

export const ignore = internalMutation({
  args: { actorId: v.id("users"), reviewId: v.id("shortlistDecisionReviews"), note: v.string() },
  handler: async (ctx, args) => {
    const { user } = await resolveActor(ctx, args.actorId); requireReviewer(user);
    if (!args.note.trim()) throw new Error("Give a reason for ignoring this reply.");
    const review = await ctx.db.get(args.reviewId);
    if (!review || ["confirmed", "auto_applied"].includes(review.status)) throw new Error("That reply has already been applied.");
    await ctx.db.patch(review._id, { status: "ignored", reviewedAt: Date.now(), reviewedBy: user._id, reviewNote: args.note.trim().slice(0, 500) });
    return { ok: true };
  },
});

export const keepForReview = internalMutation({
  args: { actorId: v.id("users"), reviewId: v.id("shortlistDecisionReviews"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await resolveActor(ctx, args.actorId); requireReviewer(user);
    const review = await ctx.db.get(args.reviewId);
    if (!review || ["confirmed", "ignored", "auto_applied"].includes(review.status)) throw new Error("That reply has already been completed.");
    await ctx.db.patch(review._id, {
      status: "review_required",
      reviewedAt: Date.now(),
      reviewedBy: user._id,
      reviewNote: args.note?.trim().slice(0, 500) || "Kept for later review.",
    });
    return { ok: true };
  },
});

/**
 * Pipeline-only historical repair. `dryRun` is deliberately required. A real
 * run creates review-queue rows only; historical mail never moves candidates.
 */
export const reconcileRecent = internalAction({
  args: { dryRun: v.boolean(), days: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ dryRun: boolean; days: number; scanned: number; rows: Record<string, unknown>[] }> => {
    const days = Math.min(Math.max(Math.floor(args.days ?? 14), 1), 31);
    const messages: Doc<"mailIntakeMessages">[] = await ctx.runQuery(internal.mailIntake.model.recentNoCvShortlist, {
      since: Date.now() - days * 86_400_000,
      limit: 2000,
    });
    const token = await getGraphToken();
    const rows: Record<string, unknown>[] = [];
    for (const message of messages) {
      const existing = await ctx.runQuery(internal.mailIntake.decisions.existing, { sourceMessageId: message._id });
      if (existing) {
        rows.push({ messageId: message.messageId, subject: message.subject, result: "already_recorded" });
        continue;
      }
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(message.mailbox)}/messages/${encodeURIComponent(message.messageId)}?$select=subject,body,from,conversationId,internetMessageId,internetMessageHeaders`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        rows.push({ messageId: message.messageId, subject: message.subject, result: `graph_${response.status}` });
        continue;
      }
      const graph = await response.json() as {
        subject?: string; body?: { content?: string }; conversationId?: string; internetMessageId?: string;
        internetMessageHeaders?: { name?: string; value?: string }[];
        from?: { emailAddress?: { address?: string } };
      };
      const inReplyTo = graph.internetMessageHeaders?.find((header) => header.name?.toLowerCase() === "in-reply-to")?.value;
      const input = {
        sourceMessageId: message._id,
        graphMessageId: message.messageId,
        conversationId: graph.conversationId,
        internetMessageId: graph.internetMessageId,
        inReplyTo,
        receivedAt: message.receivedAt,
        fromAddress: normalAddress(graph.from?.emailAddress?.address || message.fromAddress),
        subject: graph.subject ?? message.subject,
        body: newestReplyText(graph.body?.content ?? "") || graph.subject || message.subject,
        historical: true,
      };
      if (args.dryRun) {
        const contexts: DecisionContext[] = await ctx.runQuery(internal.mailIntake.decisions.context, { fromAddress: input.fromAddress });
        const matched = matchReplyRound(input, contexts as ReplyRound[]);
        const chosen = matched.round ? contexts.find((round) => round.id === matched.round!.id) : null;
        const parsed = parseShortlistReply(input.body, chosen?.roster ?? []);
        rows.push({
          messageId: message.messageId,
          subject: input.subject,
          result: chosen ? "would_queue" : "unmatched",
          matchMethod: matched.method,
          matchNote: matched.note,
          openingId: chosen?.openingId ?? null,
          decisions: parsed.decisions,
          reviewReasons: parsed.reviewReasons,
          stages: chosen?.roster.map((candidate) => ({ applicationId: candidate.applicationId, name: candidate.name, stage: candidate.stage })) ?? [],
        });
      } else {
        const result: { reviewId: string; status: "auto_applied" | "review_required" } = await ctx.runAction(internal.mailIntake.decisions.processReply, input);
        rows.push({ messageId: message.messageId, subject: input.subject, result: result.status, reviewId: result.reviewId });
      }
    }
    return { dryRun: args.dryRun, days, scanned: messages.length, rows };
  },
});
