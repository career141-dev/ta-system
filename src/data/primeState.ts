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
import type { Vocabulary } from "@/lib/query";
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
  /*
   * The words the database contains, which is a different question from which
   * rows this page primed.
   *
   * The search box reads a sentence by matching it against this. Built from
   * the working set it would be built from the people a page had already
   * fetched — which, at the moment a query is parsed, is nobody. "Colombo"
   * would then be an unrecognised word, no place filter would be applied, and
   * the screen would answer a broader question than the one that was typed
   * while looking as though it had understood.
   *
   * So it comes from the whole database instead, and is held apart from the
   * working set: it survives `resetStore` because a write does not change what
   * words exist, and re-reading a sample of 77,000 rows after every save would
   * cost more than it could possibly correct.
   */
  vocabulary: null as Vocabulary | null,
  vocabularyAt: 0,
};

/** How long the vocabulary is trusted. Long, because it moves at the speed of
 *  the database gaining new kinds of people, not new people. */
export const VOCABULARY_TTL_MS = 10 * 60 * 1000;

/** The database's vocabulary, or null if it has not been read or has aged out. */
export function primedVocabulary(now = Date.now()): Vocabulary | null {
  if (!state.vocabulary) return null;
  return now - state.vocabularyAt < VOCABULARY_TTL_MS ? state.vocabulary : null;
}

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
  invalidate();
}
