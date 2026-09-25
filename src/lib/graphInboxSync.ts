import "server-only";

import { repo } from "@/data/store";
import { fetchMailboxMessages } from "./graphInbox";
import { matchReviewReply } from "./routing";
import { extractReplyText, parseReply } from "./reviewReply";
import { revalidatePath } from "next/cache";
import { isConvex } from "@/data/mode";
import { convexMutation } from "./convexServer";
import * as backend from "@/data/convex/backend";
import { resetStore } from "@/data/prime";
import type { User } from "@/data/types";

let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 15_000; // Throttle to max once per 15s
const processedMsgIds = new Set<string>();

/**
 * Automatically check Microsoft 365 mailboxes for any review replies in the background,
 * parse incoming decisions, update candidates to shortlisted/passed, and trigger notifications.
 */
export async function syncMailboxRepliesSilently(user?: User | null): Promise<number> {
  const now = Date.now();
  if (now - lastSyncTime < SYNC_COOLDOWN_MS) {
    return 0;
  }
  lastSyncTime = now;

  const openRounds = repo.reviewRounds().filter((r) => r.status !== "returned");
  if (openRounds.length === 0) {
    return 0;
  }

  const mailboxes = [
    user?.email,
    repo.shortlistInbox(),
    process.env.MS_SENDER_EMAIL || "job@career141.com",
  ].filter((m): m is string => Boolean(m && m.includes("@")));

  let messages: { id: string; from: string; subject: string; body: string; bodyPreview: string; receivedDateTime: string }[] = [];
  try {
    messages = await fetchMailboxMessages(mailboxes, 15);
  } catch (e) {
    console.warn("[graphInboxSync] Background sync check failed:", (e as Error).message);
    return 0;
  }

  if (!messages || messages.length === 0) return 0;

  let appliedCount = 0;

  for (const msg of messages) {
    if (processedMsgIds.has(msg.id)) continue;

    const activeRounds = repo.reviewRounds().filter((r) => r.status !== "returned");
    if (activeRounds.length === 0) break;

    const target = matchReviewReply(
      { from: msg.from, subject: msg.subject, receivedAt: msg.receivedDateTime },
      {
        rounds: activeRounds,
        openings: repo.openings(),
        clients: repo.clients(),
        users: repo.users(),
      },
    );

    if (!target.round) continue;

    const round = target.round;
    const opening = repo.opening(round.openingId);
    const cleanBody = extractReplyText(msg.body || msg.bodyPreview || "");
    if (!cleanBody) continue;

    const list = round.applicationIds.map((applicationId) => {
      const app = repo.application(applicationId);
      const c = app ? repo.candidate(app.candidateId) : null;
      return { applicationId, name: c?.fullName ?? "Unknown" };
    });

    const parsed = await parseReply(cleanBody, list);
    const decided = parsed.decisions.filter((d) => d.outcome !== "hold");
    if (decided.length === 0) continue;

    processedMsgIds.add(msg.id);

    // Full decisions: Selected candidate(s) are shortlisted, unselected are passed over
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

    const res = repo.applyReviewDecisions(
      round.id,
      fullDecisions.map((d) => ({ ...d, confirmed: false })),
      cleanBody,
    );

    if (isConvex()) {
      const shortlistStage = round.kind === "director" ? "director_shortlist" : "client_shortlist";
      const actorId = round.sentBy || opening?.taLeadId || null;
      for (const d of fullDecisions) {
        if (d.outcome === "shortlisted") {
          await backend
            .moveStage({ id: actorId }, d.applicationId, shortlistStage, `Shortlisted by ${round.kind === "director" ? "Director" : "Client"}`)
            .catch((e) => console.warn(`[sync-inbox] moveStage error:`, e));
        } else if (d.outcome === "rejected") {
          await backend
            .moveStage({ id: actorId }, d.applicationId, "rejected", d.note || "Not selected from review set")
            .catch((e) => console.warn(`[sync-inbox] moveStage error:`, e));
        }
      }
      resetStore();
    }

    if (res.moved > 0 || res.rejected > 0) {
      appliedCount++;

      const shortlistedNames = fullDecisions
        .filter((d) => d.outcome === "shortlisted")
        .map((d) => {
          const app = repo.application(d.applicationId);
          return app ? repo.candidate(app.candidateId)?.fullName : null;
        })
        .filter(Boolean);

      const reviewerLabel = round.kind === "director" ? "Director" : "Client";
      const resultSummary = shortlistedNames.length > 0
        ? `${shortlistedNames.join(", ")} shortlisted`
        : "No candidates selected";

      // Notify the TA who sent it and the TA Lead
      const notifyUsers = [...new Set([round.sentBy, opening?.taLeadId])].filter(Boolean) as string[];

      for (const targetUserId of notifyUsers) {
        if (isConvex()) {
          try {
            await convexMutation("ta/notifications:create", {
              userId: targetUserId,
              type: "candidate_replied",
              title: `${reviewerLabel} reply received · Set ${round.setNumber ?? 1}`,
              body: `From ${msg.from}: "${cleanBody.slice(0, 60)}" — ${resultSummary}.`,
              jobId: opening?.id,
            });
          } catch {
            /* Fallback */
          }
        }
      }

      revalidatePath(`/openings/${round.openingId}`, "layout");
      revalidatePath(`/openings/${round.openingId}/eod`, "page");
      revalidatePath("/alerts");
      revalidatePath("/api/notifications");
    }
  }

  return appliedCount;
}
