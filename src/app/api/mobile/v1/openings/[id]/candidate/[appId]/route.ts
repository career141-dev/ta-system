import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { convexQuery } from "@/lib/convexServer";
import { mobileCandidate } from "@/lib/mobile/candidate";
import type { CandidatePayload } from "@/lib/mobile/candidateTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type LiveFollowUp = Omit<NonNullable<CandidatePayload["followUp"]>, "maxAttempts" | "canAct"> & { maxAttempts: number | null };
type LiveMessage = {
  id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  deliveryStatus: string;
  legacyStatus: string | null;
  stoppedSequence: boolean;
  sentAt: number;
  errorMessage: string | null;
};

/** The website candidate drawer, with identical opening, stage and owner boundaries. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const result = mobileCandidate(user, id, appId);
  if (result.kind === "not_found") return refuse(404, "That candidate is no longer available on this opening.");
  if (result.kind === "forbidden") return refuse(403, result.message);
  if (!isConvex()) return ok(result.payload);
  const [aiCallResults, followUp, liveMessages] = await Promise.all([
    convexQuery<CandidatePayload["aiCallResults"]>("ta/voice:callsFor", { actorId: user.id, applicationId: appId }).catch(() => []),
    convexQuery<LiveFollowUp | null>("ta/outreach:followUpState", { actorId: user.id, applicationId: appId }).catch(() => null),
    convexQuery<LiveMessage[]>("ta/outreach:messagesFor", { actorId: user.id, applicationId: appId, limit: 100 }).catch(() => []),
  ]);
  const messages = liveMessages
    .filter((row): row is LiveMessage & { channel: "whatsapp" | "email" } => row.channel === "whatsapp" || row.channel === "email")
    .map((row) => ({
      id: row.id,
      channel: row.channel,
      direction: row.direction === "outbound" ? "out" as const : "in" as const,
      body: row.body,
      subject: row.subject,
      deliveryStatus: row.deliveryStatus,
      legacyStatus: row.legacyStatus,
      stoppedSequence: row.stoppedSequence,
      errorMessage: row.errorMessage,
      sentAt: row.sentAt,
    }));
  return ok({
    ...result.payload,
    aiCallResults,
    followUp: followUp ? { ...followUp, maxAttempts: followUp.maxAttempts ?? 3, canAct: result.payload.profile.canAct } : null,
    messages,
    tabs: result.payload.tabs.map((tab) => tab.key === "chat" ? { ...tab, count: messages.length } : tab),
  });
}
