// convex/ta/stages.ts
//
// Translating between the two stage vocabularies.
//
// `applications.currentStage` stays the one stored field, so the seven-minute
// follow-up cron, the state machine and the Meta conversion events keep
// working exactly as they do now. The TA platform reads a different set of
// names, and this is the only place that knows both.
//
// The mapping is lossy in one direction on purpose. The TA platform retired
// `ta_shortlist` and `ai_call` on 13 September — shortlisting sends somebody to
// Follow-up, and the AI call happens *inside* Follow-up rather than beside it
// — so three backend stages read as one. Writing back is unambiguous: Follow-up
// always writes `follow_up`.
//
// Kept as a plain module with no Convex imports so both sides can use it and
// it can be tested on its own.

/** The backend's stored vocabulary. */
export type BackendStage =
  | "new_cvs" | "matched_candidates" | "ta_shortlist" | "ai_call" | "follow_up"
  | "second_shortlist" | "director_shortlist" | "client_review" | "interview"
  | "offer" | "placed" | "rejected" | "unresponsive";

/** The TA platform's vocabulary (src/data/types.ts). */
export type TaStage =
  | "new_cv"
  | "matched"
  | "ai_follow_up"
  | "ta_follow_up"
  | "director_review"
  | "director_shortlist"
  | "client_shortlist"
  | "interview"
  | "offer"
  | "placed"
  | "rejected"
  | "dropped_out";

const TO_TA: Record<BackendStage, TaStage> = {
  new_cvs: "new_cv",
  matched_candidates: "matched",
  // Follow-up split in two (22 Sep): the AI's own shortlist (a CV scored
  // high enough is filed as ta_shortlist, cvs/cvScoringActions.ts) is AI
  // Follow-up; a TA's shortlist has always gone to follow_up, which starts
  // the outreach, and is TA Follow-up. ai_call is no longer written.
  ta_shortlist: "ai_follow_up",
  ai_call: "ai_follow_up",
  follow_up: "ta_follow_up",
  second_shortlist: "director_review",
  director_shortlist: "director_shortlist",
  client_review: "client_shortlist",
  interview: "interview",
  offer: "offer",
  placed: "placed",
  rejected: "rejected",
  // Not the same word, but the same state: somebody who stopped answering has
  // dropped out of the process. The reason is carried separately.
  unresponsive: "dropped_out",
};

const TO_BACKEND: Record<TaStage, BackendStage> = {
  new_cv: "new_cvs",
  matched: "matched_candidates",
  ai_follow_up: "ta_shortlist",
  ta_follow_up: "follow_up",
  director_review: "second_shortlist",
  director_shortlist: "director_shortlist",
  client_shortlist: "client_review",
  interview: "interview",
  offer: "offer",
  placed: "placed",
  rejected: "rejected",
  dropped_out: "unresponsive",
};

/** A stored stage as the TA platform names it. Unknown values read as New CVs
 *  rather than throwing: a row in a stage nobody recognises is still a person
 *  who applied, and hiding them would be worse than filing them at the top. */
export function toTaStage(stage: string | null | undefined): TaStage {
  if (!stage) return "new_cv";
  return TO_TA[stage as BackendStage] ?? "new_cv";
}

/** A TA stage as it must be stored. Throws on an unknown one — a write is not
 *  a place to guess. */
export function toBackendStage(stage: string): BackendStage {
  // "follow_up" was one stage until 22 September; a page left open over the
  // release, or a saved report, still sends it. It meant the TA's Follow-up.
  if (stage === "follow_up") return TO_BACKEND.ta_follow_up;
  const mapped = TO_BACKEND[stage as TaStage];
  if (!mapped) throw new Error(`Unknown TA stage "${stage}"`);
  return mapped;
}

/**
 * The gate the backend applies when entering `second_shortlist` — the stage
 * the TA platform calls Director Review.
 *
 * Surfaced here so a screen can say what is missing BEFORE the move is
 * attempted, instead of the move throwing. The rule itself lives in
 * pipeline/pipelineStateMachine.ts and is not duplicated: this only reports.
 */
export function directorReviewBlockers(
  app: {
    followUpCvReceived?: boolean;
    followUpCurrentSalary?: boolean;
    followUpExpectedSalary?: boolean;
    followUpNoticePeriod?: boolean;
    cvFileId?: unknown;
  },
  candidate: {
    cvUploadId?: unknown;
    currentSalary?: unknown;
    expectedSalary?: unknown;
    noticePeriodDays?: unknown;
  } | null,
): string[] {
  if (!candidate) return ["the candidate record is missing"];
  const blockers: string[] = [];
  const has = (flag: boolean | undefined, fallback: boolean) =>
    flag === true || (flag === undefined && fallback);

  if (!has(app.followUpCvReceived, Boolean(candidate.cvUploadId || app.cvFileId))) blockers.push("a CV");
  if (!has(app.followUpCurrentSalary, candidate.currentSalary !== undefined)) blockers.push("current salary");
  if (!has(app.followUpExpectedSalary, candidate.expectedSalary !== undefined)) blockers.push("expected salary");
  if (!has(app.followUpNoticePeriod, candidate.noticePeriodDays !== undefined)) blockers.push("notice period");
  return blockers;
}
