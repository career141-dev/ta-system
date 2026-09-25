import { NextRequest, NextResponse } from "next/server";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { matchReviewReply } from "@/lib/routing";
import { parseReply, extractReplyText, withUnpickedRejected } from "@/lib/reviewReply";
import { revalidatePath } from "next/cache";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Only a caller holding C141_INBOUND_REVIEW_SECRET may post here, in the
 * `x-c141-secret` header. Without it anybody could post "shortlist 1" as the
 * Director and move real candidates (review of PR #56, 25 Sep). Unset, the
 * endpoint is off.
 */
function allowed(req: NextRequest): boolean {
  const secret = process.env.C141_INBOUND_REVIEW_SECRET ?? "";
  if (secret.length < 16) return false;
  const given = req.headers.get("x-c141-secret") ?? "";
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(given), h(secret));
}

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
  if (!allowed(req)) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
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

    // Everyone in the email the reply did not pick is marked not selected
    // (owner, 25 Sep). The store's write reaches the backend itself.
    const fullDecisions = withUnpickedRejected(parsed, round.applicationIds);
    const res = repo.applyReviewDecisions(
      round.id,
      fullDecisions.map((d) => ({ ...d, confirmed: false })),
      cleanBody,
    );

    const opening = repo.opening(openingId);

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
