// convex/lib/followUpScope.ts
//
// Which follow-ups the seven-minute sweep (convex/crons.ts) may run, and how a
// TA System opening's questions and answers line up with the CV pipeline's.
//
// The TA System runs the CV pipeline's own sequence — Day 0 template and
// email, a reminder every 24 hours up to the opening's attempt ceiling,
// Second Shortlist when everything is in, Unresponsive when attempts run out —
// with one difference: a TA presses Send for the first message. An opening
// switched on from the TA System carries `followUpStartsOnSend`, and the sweep
// leaves its candidates alone until that first send has gone.
//
// Pure: no Convex imports, so it is tested on its own (tests/followupscope.test.ts).

type FollowUpJob = {
  agent3Enabled?: boolean;
  enableWhatsAppFollowUp?: boolean;
  enableEmailFollowUp?: boolean;
  followUpStartsOnSend?: boolean;
};

type FollowUpApp = { followUpAttemptCount?: number };

/** The opening has the automatic sequence switched on, on at least one channel. */
export function followUpOn(job: FollowUpJob | null | undefined): boolean {
  return !!job && job.agent3Enabled === true && (job.enableWhatsAppFollowUp === true || job.enableEmailFollowUp === true);
}

/** A TA System opening whose candidate has not had their first message yet. */
export function awaitingFirstSend(job: FollowUpJob, app: FollowUpApp): boolean {
  return job.followUpStartsOnSend === true && (app.followUpAttemptCount ?? 0) === 0;
}

/** Whether the sweep should look at this opening at all. */
export function sweepCovers(job: FollowUpJob, taOnly: boolean): boolean {
  return followUpOn(job) && (!taOnly || job.followUpStartsOnSend === true);
}

/**
 * The fields the TA System's switch writes. Both channels together, as the
 * desk asked for one switch.
 *
 * Off must clear the channels too. Clearing only `agent3Enabled` left both
 * `enableWhatsAppFollowUp` and `enableEmailFollowUp` true, and
 * `followUpHelper` reads those as `!== false` — so an opening the TA had
 * switched off still sent the Day 0 template and email the moment a candidate
 * was shortlisted (18 September, once shortlisting began sending by itself).
 */
export function autoFollowUpPatch(enabled: boolean) {
  return enabled
    ? { agent3Enabled: true, enableWhatsAppFollowUp: true, enableEmailFollowUp: true, followUpStartsOnSend: true }
    : { agent3Enabled: false, enableWhatsAppFollowUp: false, enableEmailFollowUp: false };
}

type Question = { id: string; label: string };

/** The CV pipeline asks and extracts by the question's wording. */
export function questionLabels(questions: Question[]): string[] {
  return questions.map((q) => q.label.trim()).filter(Boolean);
}

/** TA answers (by question id) as the CV pipeline stores them (by wording). */
export function answersByLabel(questions: Question[], byId: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = (byId[q.id] ?? "").trim();
    if (a) out[q.label] = a;
  }
  return out;
}

/** Answers pulled from a reply (by wording) as the TA System reads them (by id). */
export function answersById(questions: Question[], byLabel: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = String(byLabel[q.label] ?? "").trim();
    if (a) out[q.id] = a;
  }
  return out;
}

/** A second channel pressed within this long of the first is the same round. */
export const ROUND_WINDOW_MS = 15 * 60_000;

export type SendChannel = "whatsapp" | "email";

/**
 * Whether a TA's single-channel send belongs to the round they just sent.
 *
 * WhatsApp now and email two minutes later is one follow-up, not two: it is
 * the same kind of message and uses one attempt. Pressing the same channel
 * again, or pressing after the window, starts the next round.
 */
export function sameRoundAs(input: {
  attempts: number;
  lastManualSendAt?: number | null;
  lastManualChannels?: string[] | null;
  channel: SendChannel | "both";
  now: number;
}): boolean {
  if (input.channel === "both" || input.attempts <= 0 || !input.lastManualSendAt) return false;
  if (input.now - input.lastManualSendAt > ROUND_WINDOW_MS) return false;
  return !(input.lastManualChannels ?? []).includes(input.channel);
}
