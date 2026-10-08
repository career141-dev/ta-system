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

/** The empty shape, so a table nobody has migrated yet reads as absent rather
 *  than as undefined — the same rule the JSON store's backfill follows. */
export function blank(): Database {
  return {
    users: [], briefs: [], clients: [], openings: [], jobPosts: [], candidates: [],
    referees: [], applications: [], callFeedback: [], interviews: [], assignments: [],
    pipelineEvents: [], reviewRounds: [], linkVault: [], alerts: [], savedSearches: [],
    savedReports: [], researchReports: [], benchmarks: [], suggestions: [], chat: [], jdChat: [],
    intake: [], outreach: [], offers: [], placements: [], esaRecords: [], aiCalls: [],
    settings: [], matchRuns: [], matchExclusions: [], liveMirror: [], bin: [],
    eodEmailCopies: [],
  };
}

/*
 * How long a loaded table is trusted before the next page re-reads it.
 *
 * The working set is shared by every request this server handles, so without
 * a lifetime it is the database as it was when the process started: a CV that
 * arrives through the live intake, or a stage moved in the other app, never
 * appears until a restart. Short enough that the desk sees the desk; long
 * enough that the layout and page of one request, and a burst of clicks, do not
 * each re-read 8,000 applications.
 *
 * Stale data is REFRESHED IN PLACE, never blanked. A request that is halfway
 * through rendering reads the same store, and emptying it underneath that
 * request is exactly the "not primed" failure the loud error exists to catch.
 */
export const TABLES_TTL_MS = 30_000;
export const CANDIDATE_TTL_MS = 60_000;
/** Candidate rows nobody has asked for in this long are let go, so the set does
 *  not grow with every search the desk ever ran. No request lasts this long. */
export const CANDIDATE_EVICT_MS = 10 * 60_000;

export const state = {
  snapshot: null as Database | null,
  /** When the small tables (users, openings, clients) were last read. */
  tablesAt: 0,
  /** Candidate id -> when its row was fetched (kept for misses too). */
  candidates: new Map<Id, number>(),
  /** Opening id -> when its applications were fetched. */
  openings: new Map<Id, number>(),
  /** When every application was last fetched; 0 when never. */
  allAt: 0,
  /*
   * Bumped whenever the working set's rows change.
   *
   * `store.ts` caches its lookup indexes against the snapshot OBJECT, and
   * priming adds rows to that same object — so without this the index built by
   * the layout (for the alert badge) never learned about the candidate the page
   * primed a moment later. `repo.candidate(id)` then answered "not here" for a
   * row that was sitting in memory, and the profile rendered a 404.
   */
  version: 0,
  /*
   * Bumped by every save — a commit from the store, or a write the backend
   * made (resetStore). A load compares it before and after its fetch: if a
   * save landed while the rows were on their way, those rows may predate it,
   * and installing them would put back what was just deleted until the next
   * refresh 30 s later (the desk, 29 Sep: "I delete something and it is not
   * gone until I refresh").
   */
  writes: 0,
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

/** Changes whenever primed rows are added or refreshed — see `state.version`. */
export function primedVersion(): number {
  return state.version;
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
 * Mark the working set stale, so the next prime refetches it.
 *
 * Called after every write, because the next read must see it.
 *
 * It used to drop the rows outright (`state.snapshot = null`). This state is a
 * module-level global shared by every request the server is handling, so a save
 * pulled the floor out from under whatever else was mid-render: the page that
 * had primed a moment earlier hit `load()` with nothing there and died with
 * "The store has not been primed". That is the 500 after saving a JD or notes,
 * the create-opening screen that never moved on to the new opening (the write
 * succeeded, the redirect never ran), and the /api/notifications poll failing
 * at the same instant — 18 September.
 *
 * Keeping the rows and expiring their timestamps gives the same freshness —
 * `refresh()` refetches on a zero `tablesAt`, and installs the new rows only
 * once they are all in — without a window where the store reads as unprimed.
 * Anything reading in that window sees rows a moment old rather than an error.
 */
export function resetStore(): void {
  state.tablesAt = 0;
  state.candidates = new Map();
  state.openings = new Map();
  state.allAt = 0;
  state.version++;
  state.writes++;
}

// ─── Saving ──────────────────────────────────────────────────────────────────

import type { CommitOp } from "./unitOfWork";

/**
 * How the store saves in Convex mode. Registered by prime.ts, which is where
 * the Convex client lives; the store itself must not import it, because the
 * unit tests load the store in plain Node where server-only modules throw.
 */
let committer: ((ops: CommitOp[]) => { ids: Record<string, string> }) | null = null;

export function setCommitter(fn: typeof committer): void {
  committer = fn;
}

export function getCommitter(): typeof committer {
  return committer;
}

/** Mark the working set changed, so derived indexes rebuild. */
export function bumpPrimed(): void {
  state.version++;
  state.writes++;
}

// ─── Temporary ids ───────────────────────────────────────────────────────────

/**
 * The store names a new row before it is saved (`op_k2x9…`) and the database
 * gives it its real id when it is. Code that created the row still holds the
 * first name — to redirect to it, or to look it up again in the same action —
 * so every rename is remembered (the newest 20,000 — below) and resolved on
 * the way back in (see withIdAliases in store.ts, and actions' redirect).
 */
const aliases = new Map<string, string>();

/** An old temporary id is only ever asked about seconds after its save, so the
 *  oldest go once there are this many — the map used to grow for the life of
 *  the process (28 Sep). */
const MAX_ALIASES = 20_000;

export function recordAliases(ids: Record<string, string>): void {
  for (const [from, to] of Object.entries(ids)) aliases.set(from, to);
  // A Map iterates in insertion order, so the first keys are the oldest.
  for (const old of aliases.keys()) {
    if (aliases.size <= MAX_ALIASES) break;
    aliases.delete(old);
  }
}

export function realId<T>(value: T): T {
  return (typeof value === "string" ? (aliases.get(value) ?? value) : value) as T;
}

/** A URL or text with every temporary id in it replaced. */
export function withRealIds(text: string): string {
  if (aliases.size === 0) return text;
  return text.replace(/[a-z]{1,5}_[a-z0-9]{6,12}/g, (m) => aliases.get(m) ?? m);
}

export function invalidateCandidate(id: Id): void {
  state.candidates.delete(id);
  state.version++;
}

export function invalidateOpening(id: Id): void {
  state.openings.delete(id);
  state.version++;
}

/**
 * A write went to Convex directly rather than through the store (the client and
 * people actions keep their own backend rules). The loaded tables are now
 * behind it, so the next load re-reads them instead of waiting out the refresh
 * interval — the list the person returns to shows what they just saved.
 */
export function markTablesStale(): void {
  state.tablesAt = 0;
  state.allAt = 0;
  state.version++;
}

