// convex/lib/assistantControl.ts
//
// Who is talking to the candidate: the assistant, or a person (30 Oct).
//
// A TA takes over a conversation with the "Take over" button, or simply by
// replying from the WhatsApp Business app on their phone (Meta's message
// echoes). A conversation flagged "Needs you" — not interested, wants a
// person, upset — waits for a TA too. While a person has it the assistant
// still reads what the candidate sends and saves the details, but it says
// nothing and sends no reminders. "Hand back" gives it back, and the
// assistant reads what the TA said before it answers.
//
// Pure: no Convex imports, so it is tested on its own (tests/assistantcontrol.test.ts).

type AppLike = {
  taTookOverAt?: number | null;
  flaggedForTaReview?: boolean | null;
  taReviewReason?: string | null;
} | null | undefined;

/** Why the assistant must stay quiet on this application, or null when it may answer. */
export function assistantQuietReason(app: AppLike): string | null {
  if (!app) return null;
  if (typeof app.taTookOverAt === "number") return "A TA has taken over this conversation.";
  if (app.flaggedForTaReview) return `Waiting for a TA: ${app.taReviewReason ?? "flagged for review"}`;
  return null;
}

type MessageLike = {
  direction: string;
  channel?: string;
  subject?: string | null;
  body?: string | null;
  senderAgent?: string | null;
};

/**
 * One line of the conversation as the model reads it. Our messages were all
 * "[outbound]", so after a TA had talked to the candidate the assistant could
 * not tell their words from its own, and asked again what the TA had settled.
 */
export function historyLine(m: MessageLike): string {
  const who =
    m.direction === "inbound" ? "Candidate"
    : m.senderAgent === "ta" ? "TA (a person on our team)"
    : "Assistant";
  const where = m.channel === "email" ? ` (email${m.subject ? `: ${m.subject}` : ""})` : "";
  return `[${who}${where}] ${(m.body ?? "").trim()}`;
}
