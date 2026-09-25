import { NextRequest, NextResponse } from "next/server";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { matchReviewReply } from "@/lib/routing";
import { parseReply, extractReplyText } from "@/lib/reviewReply";
import { revalidatePath } from "next/cache";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { resetStore } from "@/data/prime";

/**
 * Inbound webhook / API endpoint to receive email replies for EOD Review Rounds automatically.
 *
 * Supports incoming JSON or FormData from mail hooks (Microsoft Graph, Postmark, SendGrid, Mailgun, etc.).
 *
 * Example payload:
 * {
 *   "from": "director@career141.com",
 *   "subject": "Re: Delmo - Brand Manager - 24 Sep",
 *   "body": "Shortlist 1 and 3, reject 2",
 *   "inReplyTo": "<message-id@domain.com>"
 * }
 */
export async function POST(req: NextRequest) {
  try {
    await primeStore({ allApplications: true });

    let from = "";
    let subject = "";
    let body = "";
    let inReplyTo: string | undefined = undefined;
    let to = "";

    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const json = await req.json();
      from = String(json.from || json.sender || json.fromAddress || "").trim();
      subject = String(json.subject || "").trim();
      body = String(json.body || json.text || json.reply || json.content || "").trim();
      inReplyTo = json.inReplyTo || json.messageId || undefined;
      to = String(json.to || json.recipient || "").trim();
    } else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      from = String(formData.get("from") || formData.get("sender") || "").trim();
      subject = String(formData.get("subject") || "").trim();
      body = String(formData.get("reply") || formData.get("body") || formData.get("text") || "").trim();
      inReplyTo = String(formData.get("inReplyTo") || "") || undefined;
      to = String(formData.get("to") || "").trim();
    } else {
      const rawText = await req.text();
      body = rawText.trim();
    }

    if (!from || !body) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: 'from' and 'body' (or 'reply') are required." },
        { status: 400 },
      );
    }

    // Match the incoming reply against open review rounds
    const target = matchReviewReply(
      { from, subject, inReplyTo },
      {
        rounds: repo.reviewRounds(),
        openings: repo.openings(),
        clients: repo.clients(),
        users: repo.users(),
      },
    );

    if (!target.round) {
      return NextResponse.json(
        {
          ok: false,
          matched: false,
          note: `Could not match review reply to an open review round: ${target.note}`,
        },
        { status: 422 },
      );
    }

    const round = target.round;
    const openingId = round.openingId;
    const kind = round.kind;

    // Build the candidate list for this specific round
    const list = round.applicationIds.map((applicationId) => {
      const app = repo.application(applicationId);
      const c = app ? repo.candidate(app.candidateId) : null;
      return { applicationId, name: c?.fullName ?? "Unknown" };
    });

    const cleanBody = extractReplyText(body);
    const parsed = await parseReply(cleanBody, list);
    const decided = parsed.decisions.filter((d) => d.outcome !== "hold");

    if (decided.length === 0) {
      return NextResponse.json(
        {
          ok: true,
          matched: true,
          openingId,
          kind,
          decisionsCount: 0,
          message: parsed.unmatched.length
            ? `No decisions applied — unreadable clauses: ${parsed.unmatched.join(" · ")}`
            : "No valid decisions detected in the reply text.",
        },
        { status: 200 },
      );
    }

    // When director selects candidate(s) from the batch, unmentioned ones in the batch are passed over
    const decidedIds = new Set(parsed.decisions.map((d) => d.applicationId));
    const fullDecisions = [...parsed.decisions];
    for (const appId of round.applicationIds) {
      if (!decidedIds.has(appId)) {
        fullDecisions.push({
          applicationId: appId,
          outcome: "rejected",
          note: "Not selected from this set",
        });
      }
    }

    // Apply the decisions (moves candidates to director_shortlist / client_shortlist or rejected)
    const res = repo.applyReviewDecisions(
      round.id,
      fullDecisions.map((d) => ({ ...d, confirmed: false })),
      cleanBody,
    );

    const opening = repo.opening(openingId);

    if (isConvex()) {
      const shortlistStage = round.kind === "director" ? "director_shortlist" : "client_shortlist";
      const actorId = round.sentBy || opening?.taLeadId || null;
      for (const d of fullDecisions) {
        if (d.outcome === "shortlisted") {
          await backend
            .moveStage({ id: actorId }, d.applicationId, shortlistStage, `Shortlisted by ${round.kind === "director" ? "Director" : "Client"}`)
            .catch((e) => console.warn(`[route-reply] moveStage error:`, e));
        } else if (d.outcome === "rejected") {
          await backend
            .moveStage({ id: actorId }, d.applicationId, "rejected", d.note || "Not selected from review set")
            .catch((e) => console.warn(`[route-reply] moveStage error:`, e));
        }
      }
      resetStore();
    }

    revalidatePath(`/openings/${openingId}`, "layout");
    revalidatePath(`/openings/${openingId}/eod`, "page");
    revalidatePath("/alerts");
    const summary = `${res.moved} shortlisted, ${res.rejected} rejected${
      res.stale ? `, ${res.stale} stale` : ""
    }${res.repeated ? `, ${res.repeated} repeated` : ""}.`;

    return NextResponse.json({
      ok: true,
      matched: true,
      openingId,
      openingTitle: opening?.title ?? "Unknown Opening",
      kind,
      roundId: round.id,
      summary,
      stats: res,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
