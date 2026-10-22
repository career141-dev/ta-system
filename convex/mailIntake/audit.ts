// convex/mailIntake/audit.ts
//
// Director decisions against Director Shortlist — a read-only report (22 Oct).
//
// Until 22 Oct three things could put somebody in Director Shortlist without
// the Director choosing them: the shortlists@ reader read "not selected",
// "do not proceed" and "Hi all" as selections; the TA's own end-of-day copy,
// CVs attached, was filed as the Director's shortlist; and a later "not
// selected" for somebody already moved was dropped. This lists the records
// those could have left behind, for a person to check against the Director's
// emails. It changes nothing: it is a query, and any repair is a separate,
// reviewed migration.
//
// Run through the release pipeline (run_function), never from a laptop:
//   mailIntake/audit:directorDecisionReport  {"sinceDays": 60}

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { parseShortlistReply } from "../lib/shortlistReply";

const AT_OR_PAST_DIRECTOR = ["director_shortlist", "client_review", "interview", "offer", "placed"] as const;

type Row = {
  applicationId: string;
  candidate: string;
  opening: string;
  stage: string;
  detail: string;
};

export const directorDecisionReport = internalQuery({
  args: { sinceDays: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const sinceDays = Math.min(Math.max(Math.floor(args.sinceDays ?? 60), 1), 365);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 200), 1), 500);
    const since = Date.now() - sinceDays * 86_400_000;

    const rounds = (await ctx.db.query("reviewRounds").collect())
      .filter((round) => round.kind === "director" && round.sentAt >= since)
      .sort((a, b) => a.sentAt - b.sentAt);
    // The latest round each application was sent in, and what it says about them.
    const latest = new Map<string, { round: Doc<"reviewRounds">; decision: Doc<"reviewRounds">["decisions"][number] | null }>();
    for (const round of rounds) {
      for (const id of round.applicationIds) {
        latest.set(id as string, { round, decision: round.decisions.find((d) => d.applicationId === id) ?? null });
      }
    }

    const jobs = new Map<string, string>();
    const openingOf = async (jobId: Id<"jobs">) => {
      if (!jobs.has(jobId)) {
        const job = await ctx.db.get(jobId);
        jobs.set(jobId, job ? `${job.clientName} · ${job.title}` : "Unknown opening");
      }
      return jobs.get(jobId)!;
    };
    const row = async (app: Doc<"applications">, detail: string): Promise<Row> => {
      const candidate = await ctx.db.get(app.candidateId);
      return {
        applicationId: app._id,
        candidate: candidate?.fullName ?? app.candidateName ?? "Unknown candidate",
        opening: await openingOf(app.jobId),
        stage: app.currentStage,
        detail,
      };
    };
    const push = (list: Row[], r: Row) => { if (list.length < limit) list.push(r); };

    /** At or past Director Shortlist, sent in a round, and the round has no "shortlisted" for them. */
    const noSelection: Row[] = [];
    /** At or past Director Shortlist, but the round recorded "not selected" or "hold". */
    const decisionSaysNo: Row[] = [];
    /** Moved by a shortlist mail with CVs — the path the TA's own copy took. */
    const movedByShortlistMail: Row[] = [];
    /** At or past Director Shortlist without ever being in a Director email in the period. */
    const neverSent: Row[] = [];
    /** The round says shortlisted, but they are still in Director Review. */
    const selectedNotMoved: Row[] = [];
    /** Still in Director Review a week after the email, with no decision. */
    const waiting: Row[] = [];

    for (const stage of AT_OR_PAST_DIRECTOR) {
      const apps = await ctx.db.query("applications").withIndex("by_stage", (q) => q.eq("currentStage", stage)).collect();
      for (const app of apps) {
        const mailMove = (app.stageHistory ?? []).find((h) =>
          h.stage === "director_shortlist" && (h.note ?? "").startsWith("Director shortlist received at")
          && Date.parse(h.enteredAt) >= since);
        if (mailMove) push(movedByShortlistMail, await row(app, `Moved ${mailMove.enteredAt}: ${mailMove.note}`));

        const sent = latest.get(app._id);
        if (!sent) {
          if ((app.lastStageChangedAt ?? 0) >= since) push(neverSent, await row(app, "Not in any Director email in the period."));
          continue;
        }
        const when = new Date(sent.round.sentAt).toISOString().slice(0, 10);
        if (!sent.decision) push(noSelection, await row(app, `Sent ${when} in "${sent.round.subject}"; no decision recorded.`));
        else if (sent.decision.outcome !== "shortlisted") {
          push(decisionSaysNo, await row(app, `Sent ${when}; recorded ${sent.decision.outcome}${sent.decision.confirmed ? " (confirmed)" : ""}: ${sent.decision.note ?? ""}`));
        }
      }
    }

    const weekAgo = Date.now() - 7 * 86_400_000;
    for (const [id, sent] of latest) {
      const app = await ctx.db.get(id as Id<"applications">);
      if (!app || app.currentStage !== "second_shortlist") continue;
      if (sent.decision?.outcome === "shortlisted") push(selectedNotMoved, await row(app, `Recorded shortlisted: ${sent.decision.note ?? ""}`));
      else if (!sent.decision && sent.round.sentAt < weekAgo) {
        push(waiting, await row(app, `Sent ${new Date(sent.round.sentAt).toISOString().slice(0, 10)} in "${sent.round.subject}".`));
      }
    }

    // Replies the old reader applied, read again with today's reader. A
    // difference is somebody whose recorded decision may be the misread one.
    const readDifferently: (Row & { recorded: string; nowReads: string; reply: string })[] = [];
    const reviews = (await ctx.db.query("shortlistDecisionReviews").collect())
      .filter((review) => review.receivedAt >= since && (review.status === "auto_applied" || review.status === "confirmed") && review.roundId);
    for (const review of reviews) {
      const round = await ctx.db.get(review.roundId!);
      if (!round) continue;
      const roster = [];
      for (const applicationId of round.applicationIds) {
        const app = await ctx.db.get(applicationId);
        const candidate = app ? await ctx.db.get(app.candidateId) : null;
        roster.push({ applicationId: applicationId as string, name: candidate?.fullName ?? app?.candidateName ?? "Unknown candidate" });
      }
      const now = new Map(parseShortlistReply(review.replyText, roster).decisions.map((d) => [d.applicationId, d.outcome]));
      for (const recorded of round.decisions) {
        const reads = now.get(recorded.applicationId as string) ?? "no decision";
        if (reads === recorded.outcome) continue;
        // A person who confirmed a different outcome than the reader proposed
        // overruled it on purpose; only the reader's own proposals are suspect.
        const proposed = review.decisions.find((d) => d.applicationId === recorded.applicationId);
        if (!proposed || proposed.outcome !== recorded.outcome) continue;
        const app = await ctx.db.get(recorded.applicationId);
        if (!app || readDifferently.length >= limit) continue;
        readDifferently.push({
          ...(await row(app, `${review.status === "auto_applied" ? "Applied automatically" : "Confirmed as proposed"} from ${review.fromAddress}`)),
          recorded: recorded.outcome,
          nowReads: reads,
          reply: review.replyText.slice(0, 300),
        });
      }
    }

    return {
      sinceDays,
      counts: {
        readDifferently: readDifferently.length,
        decisionSaysNo: decisionSaysNo.length,
        movedByShortlistMail: movedByShortlistMail.length,
        noSelection: noSelection.length,
        neverSent: neverSent.length,
        selectedNotMoved: selectedNotMoved.length,
        waiting: waiting.length,
      },
      readDifferently, decisionSaysNo, movedByShortlistMail, noSelection, neverSent, selectedNotMoved, waiting,
    };
  },
});
