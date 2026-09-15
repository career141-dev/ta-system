/**
 * The primed working set, and nothing that fetches it.
 *
 * Split from `prime.ts` deliberately. `store.ts` needs to READ this state, and
 * `prime.ts` reaches the backend — so importing one from the other would drag
 * the Convex client, and the admin key it holds, into every module that
 * touches the store. It also broke the test runner outright: `server-only`
 * throws in plain Node, and the tests are plain Node.
 *
 * Nothing here does I/O. It is a box the loader fills and the store reads.
 */

import type { Database, Id } from "@/data/types";
import { invalidate } from "@/data/convex/snapshot";

/** The empty shape, so a table nobody has migrated yet reads as absent rather
 *  than as undefined — the same rule the JSON store's backfill follows. */
export function blank(): Database {
  return {
    users: [], briefs: [], clients: [], openings: [], jobPosts: [], candidates: [],
    referees: [], applications: [], callFeedback: [], interviews: [], assignments: [],
    pipelineEvents: [], reviewRounds: [], linkVault: [], alerts: [], savedSearches: [],
    savedReports: [], researchReports: [], benchmarks: [], suggestions: [], chat: [],
    intake: [], outreach: [], offers: [], placements: [], esaRecords: [], aiCalls: [],
    settings: [], matchRuns: [], matchExclusions: [], liveMirror: [],
  };
}

export const state = {
  snapshot: null as Database | null,
  candidates: new Set<Id>(),
  openings: new Set<Id>(),
  all: false,
  version: 0,
};

/** The primed working set, or null when nothing has been primed yet. */
export function primed(): Database | null {
  return state.snapshot;
}

/** True once a candidate has been fetched, so a miss can be told from a blank. */
export function hasCandidate(id: Id): boolean {
  return state.candidates.has(id);
}

/** The message a missed candidate raises — kept next to the thing that fixes it. */
export function missingCandidateMessage(id: Id): string {
  return (
    `Candidate ${id} was not primed. A page reads candidates from the working set, ` +
    `so it has to say which ones it needs: await primeStore({ openingId }) for an ` +
    `opening's people, or await primeStore({ candidateIds }) for named ones.`
  );
}

/**
 * Forget the working set.
 *
 * Called after every write, because the next read must see it. The cache in
 * front of the backend goes too — a stale row there would just repopulate this.
 */
export function resetStore(): void {
  state.snapshot = null;
  state.candidates = new Set();
  state.openings = new Set();
  state.all = false;
  state.version++;
  invalidate();
}
