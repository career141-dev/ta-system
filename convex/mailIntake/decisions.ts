// Durable shortlist decision queue. No mailbox state is changed here: Graph is
// read-only, and every candidate move is written through the pipeline state
// machine with the source email kept as evidence.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
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
import type { AiReading } from "../lib/directorReplyAi";
import { SHORTLIST_MAILBOX } from "./model";

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

/**
 * The review round a TA's own copy of an end-of-day email belongs to: the same
 * subject, from the TA who sent the round, within an hour of it. Exactly one,
 * or none.
 */
async function roundForCopy(
  ctx: QueryCtx,
  args: { subject: string; fromAddress: string; receivedAt: number },
): Promise<Doc<"reviewRounds"> | null> {
  const subject = args.subject.trim().replace(/\s+/g, " ").toLowerCase();
  const candidates = [];
  for (const candidate of (await ctx.db.query("reviewRounds").collect()).filter((row) => row.status !== "returned")) {
    if (candidate.subject.trim().replace(/\s+/g, " ").toLowerCase() !== subject) continue;
    if (Math.abs(args.receivedAt - candidate.sentAt) > 60 * 60 * 1000) continue;
    const sender = await ctx.db.get(candidate.sentBy);
    const addresses = [normalAddress(sender?.email), normalAddress(sender?.routingEmail)].filter(Boolean);
    if (addresses.includes(normalAddress(args.fromAddress))) candidates.push(candidate);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Read-only: the round a historical copy would teach, for a dry run. */
export const findRoundForCopy = internalQuery({
  args: { subject: v.string(), fromAddress: v.string(), receivedAt: v.number() },
  handler: async (ctx, args) => (await roundForCopy(ctx, args))?._id ?? null,
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
    if (!round) round = await roundForCopy(ctx, args);
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

/**
 * What a reply says and whether it can be applied without a person: matched to
 * exactly one round by its thread (not by subject alone), from the recorded
 * Director or client contact, read without doubt, and nobody it names would
 * be left where they are or taken back off a shortlist. One judgement for the
 * live reader, the repair's dry run and its real run.
 */
function assessReply(
  message: { subject: string; body: string; conversationId?: string | null; inReplyTo?: string | null },
  contexts: DecisionContext[],
  pinnedRoundId?: string,
) {
  const pinned = pinnedRoundId ? contexts.find((round) => round.id === pinnedRoundId) : undefined;
  const matched: ReturnType<typeof matchReplyRound> = pinned
    ? { round: pinned, method: "conversation", note: "Matched by the TA's email with the CVs in the same thread." }
    : matchReplyRound(message, contexts as ReplyRound[]);
  const chosen = matched.round ? contexts.find((round) => round.id === matched.round!.id) ?? null : null;
  const parsed = parseShortlistReply(message.body, chosen?.roster ?? []);
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
  const clear = Boolean(chosen?.senderAuthorized) && parsed.autoSafe && reviewReasons.length === 0
    && matched.method !== "none" && matched.method !== "subject";
  return { matched, chosen, parsed, reviewReasons: [...new Set(reviewReasons)], clear };
}

type ReplyArgs = {
  sourceMessageId?: Id<"mailIntakeMessages">; graphMessageId: string; conversationId?: string; internetMessageId?: string;
  inReplyTo?: string; receivedAt: number; fromAddress: string; subject: string; body: string; historical?: boolean;
  /** Dry run only: the threads the TAs' copies would teach, round by conversation. */
  taught?: { conversationId: string; roundId: string }[];
};

/**
 * What a reply will do, decided once for the live reader and the catch-up
 * alike (23 October):
 *   1. its round — by thread, as before; or, for a set the TA emailed from
 *      Outlook, rebuilt from the TA's email with the CVs in the same thread
 *      (aiReader.findSetInThread; created only when not a dry run);
 *   2. the strict reader (assessReply);
 *   3. where that will not act alone, the AI reader against the set's names,
 *      applied under the owner's rules when it reads every candidate clearly.
 */
async function planReply(ctx: ActionCtx, args: ReplyArgs, dryRun: boolean) {
  let contexts: DecisionContext[] = (await ctx.runQuery(internal.mailIntake.decisions.context, { fromAddress: args.fromAddress }))
    .map((round: DecisionContext) => {
      const conversationId = round.conversationId ? null : args.taught?.find((t) => t.roundId === round.id)?.conversationId;
      return conversationId ? { ...round, conversationId } : round;
    });
  let assessed = assessReply(args, contexts);
  let rebuilt: string | null = null;
  if (!assessed.chosen && (DIRECTOR_MAILBOXES as readonly string[]).includes(normalAddress(args.fromAddress))) {
    const set = await ctx.runAction(internal.mailIntake.aiReader.findSetInThread, {
      conversationId: args.conversationId, subject: args.subject, before: args.receivedAt,
    });
    rebuilt = set.note;
    if (set.found && set.openingId && set.sentBy && set.messageId) {
      let roundId = `dry-run:${set.messageId}`;
      if (dryRun) {
        contexts = [...contexts, {
          id: roundId, openingId: set.openingId, kind: "director", token: roundId, subject: set.subject ?? args.subject,
          status: "awaiting", sentAt: set.sentAt ?? args.receivedAt, sentBy: set.sentBy, conversationId: set.conversationId ?? null,
          internetMessageId: null, messageId: set.messageId, senderAuthorized: true,
          openingTitle: "", clientName: "", roster: set.roster.map((r) => ({ ...r })),
        }];
      } else {
        roundId = await ctx.runMutation(internal.mailIntake.aiReader.createRoundFromThread, {
          openingId: set.openingId as Id<"jobs">, sentBy: set.sentBy as Id<"users">, sentAt: set.sentAt ?? args.receivedAt,
          subject: set.subject ?? args.subject, messageId: set.messageId, conversationId: set.conversationId,
          applicationIds: set.roster.map((r) => r.applicationId as Id<"applications">),
        });
        contexts = await ctx.runQuery(internal.mailIntake.decisions.context, { fromAddress: args.fromAddress });
      }
      assessed = assessReply(args, contexts, roundId);
    }
  }
  let { decisions, reviewReasons, clear } = { decisions: assessed.parsed.decisions, reviewReasons: assessed.reviewReasons, clear: assessed.clear };
  let readBy: "rules" | "ai" = "rules";
  if (assessed.chosen && !clear && assessed.chosen.senderAuthorized) {
    const ai: AiReading = await ctx.runAction(internal.mailIntake.aiReader.readDirectorReply, {
      text: newestReplyText(args.body) || args.body,
      roster: assessed.chosen.roster.map((row) => ({ applicationId: row.applicationId, name: row.name })),
    });
    if (ai.clear) {
      decisions = ai.decisions;
      reviewReasons = [];
      clear = true;
      readBy = "ai";
    } else {
      reviewReasons = [...new Set([...reviewReasons, ...ai.problems])];
    }
  }
  if (!assessed.chosen && rebuilt) reviewReasons = [...new Set([...reviewReasons, rebuilt])];
  return { ...assessed, decisions, reviewReasons, clear, readBy };
}

export const processReply = internalAction({
  args: {
    sourceMessageId: v.optional(v.id("mailIntakeMessages")), graphMessageId: v.string(),
    conversationId: v.optional(v.string()), internetMessageId: v.optional(v.string()), inReplyTo: v.optional(v.string()),
    receivedAt: v.number(), fromAddress: v.string(), subject: v.string(), body: v.string(),
    historical: v.optional(v.boolean()),
    /** A historical reply that reads clearly is applied, not queued (reconcileFromMailbox). */
    applyClear: v.optional(v.boolean()),
    /** Report what the reply would do; write nothing (the catch-up's dry run). */
    dryRun: v.optional(v.boolean()),
    taught: v.optional(v.array(v.object({ conversationId: v.string(), roundId: v.string() }))),
  },
  handler: async (ctx, args): Promise<{
    reviewId: string; status: "auto_applied" | "review_required" | "would_move" | "would_review" | "unmatched"; note: string;
    openingId?: string; candidateIds: string[];
    plan?: { readBy: "rules" | "ai"; job: string | null; moves: { name: string; from: string; to: string; note: string }[]; reasons: string[] };
  }> => {
    if (args.dryRun) {
      const plan = await planReply(ctx, args, true);
      const names = new Map((plan.chosen?.roster ?? []).map((row) => [row.applicationId, row]));
      const to = (o: string) => (o === "shortlisted" ? SHORTLIST_STAGE[plan.chosen?.kind ?? "director"] : o === "rejected" ? "rejected" : "stays (task noted)");
      return {
        reviewId: "", candidateIds: [], openingId: plan.chosen?.openingId,
        status: !plan.chosen ? "unmatched" : plan.clear && (args.historical ? args.applyClear === true : true) ? "would_move" : "would_review",
        note: plan.reviewReasons.join(" "),
        plan: {
          readBy: plan.readBy,
          job: plan.chosen ? `${plan.chosen.clientName} · ${plan.chosen.openingTitle}`.replace(/^ · $/, "") || null : null,
          moves: plan.clear ? plan.decisions.map((d) => ({
            name: names.get(d.applicationId)?.name ?? d.applicationId, from: names.get(d.applicationId)?.stage ?? "?",
            to: to(d.outcome), note: d.evidence,
          })) : [],
          reasons: plan.clear ? [] : plan.reviewReasons,
        },
      };
    }
    if (!args.sourceMessageId) throw new Error("A shortlist reply is recorded against its queue row.");
    const sourceMessageId = args.sourceMessageId;
    const prior = await ctx.runQuery(internal.mailIntake.decisions.existing, { sourceMessageId });
    if (prior) return {
      reviewId: prior._id as string,
      status: prior.status === "auto_applied" ? "auto_applied" : "review_required",
      note: "This message already has a shortlist decision record.",
      openingId: prior.openingId as string | undefined,
      candidateIds: [],
    };
    const plan = await planReply(ctx, args, false);
    const { matched, chosen, reviewReasons, clear } = plan;
    const decisions = plan.decisions.map((decision) => ({ ...decision, applicationId: decision.applicationId as Id<"applications"> }));
    const reviewId = await ctx.runMutation(internal.mailIntake.decisions.createReview, {
      sourceMessageId, graphMessageId: args.graphMessageId,
      conversationId: args.conversationId, internetMessageId: args.internetMessageId, inReplyTo: args.inReplyTo,
      receivedAt: args.receivedAt, fromAddress: args.fromAddress, subject: args.subject,
      replyText: args.body.slice(0, 20_000), roundId: chosen?.id as Id<"reviewRounds"> | undefined,
      openingId: chosen?.openingId as Id<"jobs"> | undefined, matchMethod: matched.method,
      matchNote: plan.readBy === "ai" ? `${matched.note} Read by the AI reader.` : matched.note, senderAuthorized: chosen?.senderAuthorized ?? false,
      decisions, reviewReasons, historical: args.historical ?? false,
    });
    // A historical reply is applied only when the owner's repair asks for it
    // (reconcileFromMailbox with applyClear, 23 October) and it reads clearly.
    const automatic = clear && (args.historical ? args.applyClear === true : process.env.C141_SHORTLIST_AUTO_APPLY === "on");
    if (automatic) {
      const result: ApplyResult = await ctx.runMutation(internal.mailIntake.decisions.applyAutomatic, { reviewId });
      return { reviewId: reviewId as string, status: "auto_applied", note: `${result.moved} shortlisted, ${result.rejected} rejected; ${result.stale} stale.`, openingId: chosen?.openingId, candidateIds: chosen?.roster.map((row) => row.candidateId).filter(Boolean) as string[] ?? [] };
    }
    await ctx.runMutation(internal.mailIntake.decisions.requireReview, { reviewId });
    // A historical catch-up queues dozens at once; they are on Shortlist
    // decisions, without a notification each.
    if (chosen && !args.historical) {
      for (const userId of [...new Set([chosen.sentBy, chosen.taLeadId].filter((id): id is string => Boolean(id)))]) {
        await ctx.runMutation(internal.ta.notifications.create, {
          userId, type: "candidate_replied", title: "Shortlist reply needs review",
          body: `${chosen.clientName} · ${chosen.openingTitle}: ${matched.note}`,
          jobId: chosen.openingId,
        });
      }
    }
    return { reviewId: reviewId as string, status: "review_required", note: reviewReasons.join(" ") || "Check the proposed decisions.", openingId: chosen?.openingId, candidateIds: chosen?.roster.map((row) => row.candidateId).filter(Boolean) as string[] ?? [] };
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
      rows.push(await reconcileOne(ctx, token, {
        mailbox: message.mailbox,
        graphMessageId: message.messageId,
        receivedAt: message.receivedAt,
        fromAddress: message.fromAddress,
        subject: message.subject,
        sourceMessageId: message._id,
        dryRun: args.dryRun,
      }));
    }
    return { dryRun: args.dryRun, days, scanned: messages.length, rows };
  },
});

/**
 * One historical Director reply, read again from Graph: in a dry run, what it
 * would queue; otherwise queued for a lead's review (`historical` — never
 * applied automatically). A reply with no queue row yet gets one first, marked
 * done so the queue never picks it up (model.recordHistoricalShortlist).
 */
async function reconcileOne(
  ctx: ActionCtx,
  token: string | null,
  m: {
    mailbox: string; graphMessageId: string; receivedAt: number; fromAddress: string; subject: string;
    sourceMessageId: Id<"mailIntakeMessages"> | null; dryRun: boolean;
    /** Apply a reply that reads clearly instead of queueing it. */
    applyClear?: boolean;
    /** Dry run only: threads the copies would teach, round id by conversation. */
    taught?: Map<string, string>;
  },
): Promise<Record<string, unknown>> {
  if (m.sourceMessageId) {
    const existing = await ctx.runQuery(internal.mailIntake.decisions.existing, { sourceMessageId: m.sourceMessageId });
    if (existing) return { messageId: m.graphMessageId, subject: m.subject, result: "already_recorded" };
  }
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m.mailbox)}/messages/${encodeURIComponent(m.graphMessageId)}?$select=subject,body,from,conversationId,internetMessageId,internetMessageHeaders`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return { messageId: m.graphMessageId, subject: m.subject, result: `graph_${response.status}` };
  const graph = await response.json() as {
    subject?: string; body?: { content?: string }; conversationId?: string; internetMessageId?: string;
    internetMessageHeaders?: { name?: string; value?: string }[];
    from?: { emailAddress?: { address?: string } };
  };
  const inReplyTo = graph.internetMessageHeaders?.find((header) => header.name?.toLowerCase() === "in-reply-to")?.value;
  const base = {
    graphMessageId: m.graphMessageId,
    conversationId: graph.conversationId,
    internetMessageId: graph.internetMessageId,
    inReplyTo,
    receivedAt: m.receivedAt,
    fromAddress: normalAddress(graph.from?.emailAddress?.address || m.fromAddress),
    subject: graph.subject ?? m.subject,
    body: newestReplyText(graph.body?.content ?? "") || graph.subject || m.subject,
    historical: true,
  };
  if (m.dryRun) {
    const planned = await ctx.runAction(internal.mailIntake.decisions.processReply, {
      ...base, dryRun: true, applyClear: m.applyClear,
      taught: [...(m.taught ?? new Map<string, string>()).entries()].map(([conversationId, roundId]) => ({ conversationId, roundId })),
    });
    return {
      messageId: m.graphMessageId,
      receivedAt: new Date(m.receivedAt).toISOString(),
      from: base.fromAddress,
      subject: base.subject,
      result: planned.status,
      readBy: planned.plan?.readBy,
      job: planned.plan?.job ?? null,
      moves: planned.plan?.moves ?? [],
      reviewReasons: planned.plan?.reasons ?? [],
    };
  }
  const sourceMessageId = m.sourceMessageId ?? await ctx.runMutation(internal.mailIntake.model.recordHistoricalShortlist, {
    messageId: m.graphMessageId,
    receivedAt: m.receivedAt,
    subject: base.subject,
    fromAddress: base.fromAddress,
    conversationId: base.conversationId,
    internetMessageId: base.internetMessageId,
  });
  if (!m.sourceMessageId) {
    const existing = await ctx.runQuery(internal.mailIntake.decisions.existing, { sourceMessageId });
    if (existing) return { messageId: m.graphMessageId, subject: base.subject, result: "already_recorded" };
  }
  const result: { reviewId: string; status: string } = await ctx.runAction(
    internal.mailIntake.decisions.processReply,
    { ...base, sourceMessageId, applyClear: m.applyClear },
  );
  return { messageId: m.graphMessageId, subject: base.subject, result: result.status, reviewId: result.reviewId };
}

/**
 * Director replies that reached shortlists@ before it was read (23 October).
 * The reader only reads mail from the moment it was switched on — this
 * morning — so every earlier reply was never seen, and 67 review rounds sat
 * "awaiting". This lists them straight from the mailbox: replies from a
 * Director address, with no attachments (the TA's own end-of-day copy carries
 * the CVs), received in the last `days` and before the reader started.
 *
 * Pipeline-only; `dryRun` is required. A real run queues each reply for a
 * lead to confirm on Shortlist decisions — it never moves a candidate.
 */
export const reconcileFromMailbox = internalAction({
  args: {
    dryRun: v.boolean(),
    days: v.optional(v.number()),
    /** Apply the Director replies that read clearly; the rest go to review (owner, 23 Oct). */
    applyClear: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{
    dryRun: boolean; days: number; listed: number; copiesTaught: number; fromDirectors: number;
    summary: Record<string, number>; clientReplies: { receivedAt: string; from: string; subject: string }[];
    rows: Record<string, unknown>[];
  }> => {
    const days = Math.min(Math.max(Math.floor(args.days ?? 21), 1), 60);
    const box = await ctx.runQuery(internal.mailIntake.model.mailbox, { mailbox: SHORTLIST_MAILBOX });
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const until = new Date(box?.backfillFrom ?? Date.now()).toISOString();
    const token = await getGraphToken();
    const directors = new Set<string>(DIRECTOR_MAILBOXES);
    const listed: { id: string; subject?: string; receivedDateTime?: string; hasAttachments?: boolean; conversationId?: string; internetMessageId?: string; from?: { emailAddress?: { address?: string } } }[] = [];
    let url: string | undefined =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SHORTLIST_MAILBOX)}/mailFolders/inbox/messages` +
      `?$filter=receivedDateTime ge ${since} and receivedDateTime lt ${until}` +
      `&$select=id,subject,from,receivedDateTime,hasAttachments,conversationId,internetMessageId&$top=200`;
    for (let page = 0; url && page < 20; page++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`shortlists@ could not be listed: Graph ${response.status} ${(await response.text()).slice(0, 200)}`);
      const data = await response.json() as { value?: typeof listed; "@odata.nextLink"?: string };
      listed.push(...(data.value ?? []));
      url = data["@odata.nextLink"];
    }
    const oldestFirst = (a: { receivedDateTime?: string }, b: { receivedDateTime?: string }) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? "");
    const from = (m: (typeof listed)[number]) => normalAddress(m.from?.emailAddress?.address);

    // 1. The TAs' own copies of their end-of-day emails teach each round its
    //    thread, so a Director reply matches its round exactly — not by
    //    subject alone, which would always need a person to confirm.
    const taught = new Map<string, string>();
    for (const m of listed.filter((x) => x.hasAttachments && from(x).endsWith("@career141.com") && !directors.has(from(x))).sort(oldestFirst)) {
      const copy = { subject: m.subject ?? "", fromAddress: from(m), receivedAt: Date.parse(m.receivedDateTime ?? "") };
      if (args.dryRun) {
        const roundId = await ctx.runQuery(internal.mailIntake.decisions.findRoundForCopy, copy);
        if (roundId && m.conversationId) taught.set(m.conversationId, roundId);
      } else {
        const r = await ctx.runMutation(internal.mailIntake.decisions.attachRoundTransport, {
          ...copy, conversationId: m.conversationId, internetMessageId: m.internetMessageId, messageId: m.id,
        });
        if (r.attached && m.conversationId) taught.set(m.conversationId, r.roundId as string);
      }
    }

    // 2. The Director's replies, oldest first.
    const replies = listed.filter((m) => !m.hasAttachments && directors.has(from(m))).sort(oldestFirst);
    const rows: Record<string, unknown>[] = [];
    for (const m of replies) {
      rows.push(await reconcileOne(ctx, token, {
        mailbox: SHORTLIST_MAILBOX,
        graphMessageId: m.id,
        receivedAt: Date.parse(m.receivedDateTime ?? new Date().toISOString()),
        fromAddress: from(m),
        subject: m.subject ?? "",
        sourceMessageId: null,
        dryRun: args.dryRun,
        applyClear: args.applyClear,
        taught,
      }));
    }

    // 3. Client replies. Client sets are sent outside the system, so no round
    //    records who was in them; they are listed for a person to act on.
    const clientReplies = listed
      .filter((m) => !m.hasAttachments && !from(m).endsWith("@career141.com"))
      .sort(oldestFirst)
      .map((m) => ({ receivedAt: m.receivedDateTime ?? "", from: from(m), subject: m.subject ?? "" }));

    const summary: Record<string, number> = {};
    for (const row of rows) summary[String(row.result)] = (summary[String(row.result)] ?? 0) + 1;
    for (const row of rows) for (const move of (row.moves as { to: string }[] | undefined) ?? []) summary[`move to ${move.to}`] = (summary[`move to ${move.to}`] ?? 0) + 1;
    return { dryRun: args.dryRun, days, listed: listed.length, copiesTaught: taught.size, fromDirectors: replies.length, summary, clientReplies, rows };
  },
});
