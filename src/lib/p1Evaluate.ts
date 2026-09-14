/**
 * P1 evaluation and the continue-to-P2 rule (14 September).
 *
 * Continue only when a model: covers all people with valid answers except at
 * most 5 invalid or truncated, keeps ≥ 15 of the recruiter's 18 Shortlist+Maybe,
 * and puts forward ≤ 36. Missing coverage never passes: if a model could still
 * reach or miss the bar depending on the unanswered people, it is
 * "inconclusive"; if even the best case misses, "stop".
 */
export type Verdict = "continue" | "stop" | "inconclusive";

export interface EvalRow {
  id: string;
  job: number;
  candidateId: string;
  model: string;
  status: string;
  parsed: unknown;
  flags?: string[];
  ledgerUsd?: number;
  ledgerStatus?: string;
}

const pos = (d: string | undefined) => d === "shortlist" || d === "maybe";

export function evaluateP1(input: { rows: EvalRow[]; truth: Record<string, string | undefined>; peoplePerModel: number }) {
  const models = [...new Set(input.rows.map((r) => r.model))];
  const truePos = Object.values(input.truth).filter(pos).length;
  return models.map((model) => {
    const rows = input.rows.filter((r) => r.model === model);
    const decided = rows.filter((r) => r.status === "ok");
    const unanswered = rows.filter((r) => r.status !== "ok");
    const decision = (r: EvalRow) => (r.parsed as { decision?: string }).decision;
    const kept = decided.filter((r) => pos(input.truth[`${r.job}|${r.candidateId}`]) && decision(r) !== "reject").length;
    const putForward = decided.filter((r) => decision(r) !== "reject").length;
    const acceptable = decided.filter((r) => decision(r) !== "reject" && pos(input.truth[`${r.job}|${r.candidateId}`])).length;
    const unansweredPos = unanswered.filter((r) => pos(input.truth[`${r.job}|${r.candidateId}`])).length;
    const invalidOrTruncated = rows.filter((r) => r.status === "invalid_output" || r.status === "truncated").length;
    const notRunOrFailed = rows.filter((r) => ["not_run", "no_response", "http_error"].includes(r.status)).length;
    const complete = rows.length === input.peoplePerModel && notRunOrFailed === 0;

    // Best and worst case over the unanswered people.
    const bestKept = kept + unansweredPos;
    const worstForward = putForward;
    const bestForward = putForward + unanswered.length;
    const passesNow = kept >= 15 && putForward <= 36 && invalidOrTruncated <= 5;
    let verdict: Verdict;
    let why: string;
    if (complete && passesNow) { verdict = "continue"; why = "full coverage and all three conditions met"; }
    else if (complete) { verdict = "stop"; why = "full coverage, a condition missed"; }
    else if (bestKept < 15 || worstForward > 36 || invalidOrTruncated > 5) { verdict = "stop"; why = "misses the bar even if every unanswered person went its way"; }
    else { verdict = "inconclusive"; why = `${notRunOrFailed} people not run or failed; the result could go either way`; }

    return {
      model,
      verdict,
      why,
      coverage: { people: rows.length, ok: decided.length, invalid: rows.filter((r) => r.status === "invalid_output").length, truncated: rows.filter((r) => r.status === "truncated").length, notRunOrFailed },
      recruiterShortlistMaybe: truePos,
      kept,
      bestCaseKept: bestKept,
      putForward,
      bestCasePutForward: bestForward,
      acceptableShareOfPutForward: putForward ? Math.round((acceptable / putForward) * 1000) / 1000 : null,
      shortlistOnly: {
        modelShortlists: decided.filter((r) => decision(r) === "shortlist").length,
        ofWhichRecruiterShortlist: decided.filter((r) => decision(r) === "shortlist" && input.truth[`${r.job}|${r.candidateId}`] === "shortlist").length,
        recruiterShortlistsKept: decided.filter((r) => input.truth[`${r.job}|${r.candidateId}`] === "shortlist" && decision(r) !== "reject").length,
      },
      falseRejects: decided.filter((r) => pos(input.truth[`${r.job}|${r.candidateId}`]) && decision(r) === "reject").map((r) => r.id),
      answersWithConsistencyFlags: decided.filter((r) => (r.flags ?? []).length > 0).length,
      byJob: [...new Set(rows.map((r) => r.job))].sort((a, b) => a - b).map((job) => {
        const jr = decided.filter((r) => r.job === job);
        return { job, ok: jr.length, kept: jr.filter((r) => pos(input.truth[`${r.job}|${r.candidateId}`]) && decision(r) !== "reject").length, putForward: jr.filter((r) => decision(r) !== "reject").length, falseRejects: jr.filter((r) => pos(input.truth[`${r.job}|${r.candidateId}`]) && decision(r) === "reject").length };
      }),
      costUsd: { ledger: Math.round(rows.reduce((s, r) => s + (r.ledgerUsd ?? 0), 0) * 1e6) / 1e6, uncertainRequests: rows.filter((r) => r.ledgerStatus === "uncertain").length },
    };
  });
}
