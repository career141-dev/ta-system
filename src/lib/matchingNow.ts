/**
 * Where database matching is for one opening, said in one word.
 *
 * Matching runs after the response (`after()` in actions.ts), so for its first
 * seconds nothing in the database says it has started: the engine's status is
 * only set once the desk calls it, and the page the person lands on was drawn
 * before that. Testers saw no sign it was running and could not tell a slow
 * run from a dead one (25 Sep). The desk now marks the opening the moment it
 * asks, here, before `after()`, and clears it when the run ends.
 *
 * ponytail: in-process, so it assumes the one app container. After a restart
 * the mark is gone and the engine's own status is what shows.
 */

type Marks = { running: Map<string, number>; failed: Map<string, { at: number; reason: string }> };
const g = globalThis as { __c141Matching?: Marks };
const marks: Marks = (g.__c141Matching ??= { running: new Map(), failed: new Map() });

/** A run this old has died with the process that ran it, not still working. */
const MARK_STALE_MS = 6 * 60_000;
/** The engine usually answers in 30–90 s; past this it has stopped, not slowed. */
const ENGINE_SLOW_MS = 5 * 60_000;
/** How long "Matching finished" stays on screen after a run. */
const FINISHED_FOR_MS = 10 * 60_000;

export function markMatching(openingId: string, now = Date.now()) {
  marks.running.set(openingId, now);
  marks.failed.delete(openingId);
}

/** The run ended; `failure` is the reason it did not match anyone, if it did not run. */
export function clearMatching(openingId: string, failure?: string | null) {
  marks.running.delete(openingId);
  if (failure) marks.failed.set(openingId, { at: Date.now(), reason: failure });
}

export function matchingMarks(openingId: string) {
  return { markedAt: marks.running.get(openingId) ?? null, failure: marks.failed.get(openingId) ?? null };
}

/** findDatabaseMatches' reason code, as a sentence. */
export function matchFailureText(reason: string | undefined): string {
  if (reason === "jd_not_approved") return "Approve the JD first — matching reads it.";
  if (reason === "not_open") return "This opening is not open, so it is not matched.";
  return `Matching did not run (${reason ?? "no reason given"}).`;
}

export type MatchingState =
  | { kind: "reading"; since: number }
  | { kind: "running"; since: number }
  | { kind: "slow"; since: number }
  | { kind: "error"; reason: string | null }
  | { kind: "finished"; at: number; added: number; note: string | null }
  | { kind: "idle"; lastAt: number | null };

export function matchingState(i: {
  now: number;
  /** When the desk asked for a run that has not ended yet. */
  markedAt: number | null;
  /** The desk's last run that could not run at all, and why. */
  failure: { at: number; reason: string } | null;
  requirementsStatus: string | null | undefined;
  engineStatus: string | null | undefined;
  /** Set by the engine when it starts and again when it finishes. */
  engineAt: number | null;
  lastRun: { at: number; added: number; note: string | null } | null;
}): MatchingState {
  const { now, markedAt, engineAt, lastRun } = i;
  if (markedAt && now - markedAt < MARK_STALE_MS) {
    return i.requirementsStatus === "extracting" ? { kind: "reading", since: markedAt } : { kind: "running", since: markedAt };
  }
  if (i.failure && now - i.failure.at < FINISHED_FOR_MS) return { kind: "error", reason: i.failure.reason };
  if (i.engineStatus === "running") {
    const since = engineAt ?? now;
    return now - since > ENGINE_SLOW_MS ? { kind: "slow", since } : { kind: "running", since };
  }
  // The desk falls back to its own route when the engine fails, so a run saved
  // around the engine's error (a run's `at` is when it started) means
  // matching did work.
  if (i.engineStatus === "error" && !(lastRun && engineAt && lastRun.at > engineAt - ENGINE_SLOW_MS)) return { kind: "error", reason: null };
  if (lastRun && now - lastRun.at < FINISHED_FOR_MS) {
    // A run's `at` is when it started; it finished when the engine last wrote.
    const at = engineAt && engineAt > lastRun.at && engineAt - lastRun.at < ENGINE_SLOW_MS ? engineAt : lastRun.at;
    return { kind: "finished", at, added: lastRun.added, note: lastRun.note };
  }
  return { kind: "idle", lastAt: lastRun?.at ?? null };
}
