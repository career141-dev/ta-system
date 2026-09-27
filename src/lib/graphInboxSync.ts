import "server-only";

import { repo } from "@/data/store";
import { fetchMailboxMessages } from "./graphInbox";
import { matchReviewReply } from "./routing";
import { extractReplyText, parseReply, withUnpickedRejected } from "./reviewReply";
import { revalidatePath } from "next/cache";
import { isConvex } from "@/data/mode";
import { primeStore } from "@/data/prime";
import { convexMutation } from "./convexServer";

let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 15_000; // Throttle to max once per 15s
const processedMsgIds = new Set<string>();

/**
 * Automatically check Microsoft 365 mailboxes for any review replies in the background,
 * parse incoming decisions, update candidates to shortlisted/passed, and trigger notifications.
 *
 * Reads the mailboxes the sets were sent from (a reply comes back to the TA who
 * sent it) and the shortlist inbox — not the mailbox of whoever happens to be
 * looking at a page. Only a reply from the Director's or the client contact's
 * own address is applied (matchReviewReply checks the sender). Owner's call,
 * 25 Sep: replies are applied automatically.
 */
export async function syncMailboxRepliesSilently(): Promise<number> {
  const now = Date.now();
  if (now - lastSyncTime < SYNC_COOLDOWN_MS) {
    return 0;
  }
  lastSyncTime = now;

  const openRounds = repo.reviewRounds().filter((r) => r.status !== "returned");
  if (openRounds.length === 0) {
    return 0;
  }
  // The notifications feed loads very little; reading a reply needs the
  // applications in the sets and the people's names.
  await primeStore({ allApplications: true });
  await primeStore({
    candidateIds: openRounds.flatMap((r) => r.applicationIds.map((id) => repo.application(id)?.candidateId ?? "")).filter(Boolean),
  });

  const senders = openRounds.map((r) => (r.sentBy ? repo.user(r.sentBy)?.email : null));
  const mailboxes = [...new Set([...senders, repo.shortlistInbox()].filter((m): m is string => Boolean(m && m.includes("@"))))];

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

    // The store's write reaches the backend itself; moving each person again
    // through the backend moved them twice (review of #56).
    const fullDecisions = withUnpickedRejected(parsed, round.applicationIds);
    const res = repo.applyReviewDecisions(
      round.id,
      fullDecisions.map((d) => ({ ...d, confirmed: false })),
      cleanBody,
    );

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
