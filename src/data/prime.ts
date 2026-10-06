import "server-only";

/**
 * Loading the working set from Convex, so `repo` can stay synchronous.
 *
 * ── Why this shape ──────────────────────────────────────────────────────────
 *
 * The obvious move when the rows come from a server is to make every `repo`
 * method async. That was tried and abandoned: it needs an `await` at 481 call
 * sites, and 138 of those sit inside `.map()`, `.filter()` and `.find()`
 * callbacks. Making a predicate async does not fail — it silently misbehaves,
 * because a promise is always truthy, so `filter` keeps everything and `find`
 * returns the first row. Worse, it typechecks: `filter` accepts
 * `(value) => unknown`. Two sweeps introduced 64 such defects between them and
 * the compiler reported none.
 *
 * So the rows are fetched FIRST, into memory, and `repo` reads them the same
 * way it reads the JSON file. A page awaits once, at the top, and every
 * component below it stays exactly as written.
 *
 * ── What gets loaded ────────────────────────────────────────────────────────
 *
 * Everything except candidates is small: 32 users, ~20 clients, 95 openings,
 * 8,313 applications. Those are fetched whole.
 *
 * Candidates are not — there are about 77,000. But no page needs 77,000: it
 * needs the people on one opening, or the people a search returned. So
 * candidates are fetched by id from a scope the caller names, and a page that
 * asks for somebody it did not prime gets a loud error naming this function
 * rather than a blank row.
 *
 * The state itself lives in `primeState.ts`, which does no I/O — `store.ts`
 * reads that and never imports this module, so the Convex client and the admin
 * key it carries stay out of everything that merely touches the store.
 */

import type { Application, Candidate, Database, Id } from "@/data/types";
import { isConvex } from "@/data/mode";
import { assertSafeBackend } from "@/lib/safety";
import * as backend from "@/data/convex/backend";
import { blank, CANDIDATE_EVICT_MS, CANDIDATE_TTL_MS, primedVocabulary, realId, setCommitter, state, TABLES_TTL_MS } from "@/data/primeState";
import { convexMutationSync } from "@/data/convex/syncCall";
import { convexQuery } from "@/lib/convexServer";

/*
 * How the store saves: one Convex transaction per write (convex/ta/commit.ts).
 * Registered here, with the Convex client, rather than imported by the store —
 * see primeState.setCommitter.
 */
setCommitter((ops) => convexMutationSync<{ ids: Record<string, string> }>("ta/commit:apply", { ops }));

export { primed, primedVocabulary, hasCandidate, missingCandidateMessage, resetStore } from "@/data/primeState";

/** What a page needs on top of the small tables. */
export interface PrimeScope {
  /** An opening: brings its applications and everybody on them. */
  openingId?: Id | null;
  /** Named people — search results, a candidate page, an intake match. */
  candidateIds?: Id[];
  /**
   * Every application on the desk, not just one opening's.
   *
   * The dashboards and reports genuinely need this. It is opt-in because it is
   * the one read here that grows with the desk rather than with the page.
   */
  allApplications?: boolean;
  /**
   * The people currently being chased, and their records.
   *
   * Follow-up state is not derivable from the application alone: whether a
   * step is owed depends on which answers are still missing from the
   * CANDIDATE, and whether anything can be sent at all depends on their phone
   * and email. So `repo.followUps()` reads the record, and without it a
   * follow-up is silently dropped rather than reported wrong — which is why
   * the alert badge, which counts them, needs this.
   *
   * Bounded by the stage, not by the desk: 742 of 8,378 applications, fetched
   * in two parallel batches. Implies `allApplications`, since the stage cannot
   * be known before the applications are.
   */
  followUps?: boolean;
  /**
   * Read the tables and applications again unless they are a few seconds old,
   * rather than trusting the 30-second cache. Only the desk assistant asks
   * (6 Oct): "how many CVs today" is a question about now, and the answer says
   * "as of 10:42". Its per-person rate limit is what keeps this bounded.
   */
  fresh?: boolean;
}

/** How old "fresh" may be — enough that one burst of questions shares a read. */
const FRESH_MS = 5_000;

/**
 * Re-reads the roster alone. The small tables load once per process, so an
 * account added after startup would otherwise stay invisible to sign-in until
 * the server restarts.
 */
export async function refreshUsers(): Promise<void> {
  if (!isConvex() || !state.snapshot) return;
  state.snapshot.users = await backend.users({ id: null });
}

/**
 * Load the working set.
 *
 * Additive and idempotent: calling it again with a different scope adds to
 * what is held rather than replacing it, so a page can prime an opening and
 * then prime a search's results without losing the first.
 *
 * A no-op when the store is the JSON file, which is what keeps the tests — and
 * the offline build — running unchanged.
 */
/**
 * One load at a time.
 *
 * A layout and the page inside it render CONCURRENTLY, and both prime. Without
 * this they both find an unprimed store, both call `blank()`, and the second
 * one's blank overwrites whatever the first had already fetched — most
 * damagingly `db.users`, which is where the session is resolved, so the page
 * decides nobody is signed in and redirects to the sign-in screen while the
 * layout around it renders the signed-in desk perfectly well. It presents as
 * "that one page logs me out", and it moves depending on which fetch happens
 * to return first.
 *
 * Serialising is the whole fix and costs nothing: the work is additive and
 * idempotent, so the second caller finds its scope already held and returns
 * without asking the backend for anything.
 */
/** A read that a save overtook; its rows are dropped, not installed. */
class StaleRead extends Error {}

let loading: Promise<void> = Promise.resolve();

export function primeStore(scope: PrimeScope = {}): Promise<void> {
  if (!isConvex()) return Promise.resolve();
  // A scope may name a row by the id it had before it was saved.
  scope = { ...scope, openingId: realId(scope.openingId ?? null), candidateIds: scope.candidateIds?.map((id) => realId(id)) };
  // Refuses a backend that could message real people or poll live mailboxes — see lib/safety.ts.
  const safe = assertSafeBackend();
  // Queue behind whatever is in flight — including a failed one, whose
  // rejection must not cancel this caller's turn.
  // The load in flight is captured now: read inside the callback, `loading`
  // would already be this call's own promise, and it would wait on itself.
  const before = loading;
  const queued = performance.now();
  const mine = safe.then(() => before.catch(() => {})).then(() => loadInto(scope, queued));
  loading = mine.catch(() => {});
  return mine;
}

/*
 * A load slower than this is logged, with how much of it was spent waiting
 * behind other loads (28 Sep). Every page waits in the one queue above, so
 * "the desk is slow" is either the backend or the queue, and the log line says
 * which. Ids and counts only — never a name or a search.
 */
const SLOW_PRIME_MS = 2_000;

async function loadInto(scope: PrimeScope, queued: number): Promise<void> {
  const started = performance.now();
  try {
    await refresh(scope);
  } finally {
    const done = performance.now();
    if (done - queued > SLOW_PRIME_MS) {
      const what = [
        scope.openingId && `opening=${scope.openingId}`,
        scope.candidateIds?.length && `candidates=${scope.candidateIds.length}`,
        scope.allApplications && "allApplications",
        scope.followUps && "followUps",
      ].filter(Boolean).join(" ") || "tables";
      console.warn(`[prime] slow: ${Math.round(done - queued)}ms (waited ${Math.round(started - queued)}ms in queue) ${what}`);
    }
    // Whatever changed, derived indexes must rebuild. Cheap to over-bump: an
    // index is rebuilt on the next read, not here.
    state.version++;
  }
}

async function refresh(scope: PrimeScope): Promise<void> {
  const now = Date.now();
  const actor = { id: null as string | null };

  /*
   * The vocabulary, from the database rather than from the working set.
   *
   * Read before anything else uses it, because the page parses its query
   * immediately after this returns. It outlives the working set — see
   * `primeState` — so this is a read once every ten minutes, not once a page.
   */
  if (!primedVocabulary()) {
    try {
      const v = await backend.vocabulary(actor);
      state.vocabulary = {
        titles: v.titles.map((t) => t.title),
        skills: v.skills,
        industries: v.industries,
        cities: v.cities,
        employers: v.employers,
        // Not sampled by the backend: degrees and institutions are not indexed,
        // so asking for them would mean a scan. The parser simply recognises no
        // qualification words until they are, which is the honest result — the
        // filter is still there for a recruiter who sets it from the chips.
        qualifications: [],
        languages: [],
        nationalities: [],
      };
      state.vocabularyAt = Date.now();
    } catch {
      // A search that cannot read the vocabulary still runs; it reads the
      // sentence less well. Better than a page that will not render.
    }
  }

  /*
   * ── The small tables ────────────────────────────────────────────────────
   *
   * Loaded into locals first and installed only once they are complete, so the
   * store is never in a "created but not loaded" state. That state is what
   * signed the whole desk out twice: a load interrupted by a backend restart
   * left an empty `db.users`, which is where the session is resolved, and
   * nothing retried it.
   *
   * A refresh that fails keeps the rows already held. They are thirty seconds
   * old; an empty list of users is not an improvement on that.
   */
  const ttl = scope.fresh ? FRESH_MS : TABLES_TTL_MS;
  if (!state.snapshot || now - state.tablesAt > ttl) {
    const w = state.writes;
    try {
      const [users, openings, clients, whole] = await Promise.all([
        backend.users(actor),
        backend.openings(actor),
        backend.clients(actor),
        loadWholeTables(),
      ]);
      // A backend that is still starting can answer with nothing rather than an
      // error. Nobody can sign in to a desk with no users, so that is a failed
      // read, not an answer.
      if (users.length === 0) throw new Error("The backend returned no users — it may still be starting.");
      if (state.snapshot && state.writes !== w) throw new StaleRead();
      const db = state.snapshot ?? blank();
      db.users = users;
      db.openings = openings;
      // The clients table only. Clients used to be derived from the openings'
      // free-text names when the table was empty — ids that exist nowhere, so a
      // change to one could never be saved.
      db.clients = clients;
      // Every other table the desk keeps: interviews, offers, placements,
      // review rounds, the link vault, intake, follow-up records, settings…
      // Before, these were never loaded, and read as empty.
      Object.assign(db, whole);
      state.snapshot = db;
      state.tablesAt = now;
    } catch (e) {
      if (!state.snapshot) throw e;
      // A read a save overtook: what is held already has the save, and the
      // next page reads again. Anything else is said, not swallowed — rows
      // that stop updating have a reason in the log.
      if (!(e instanceof StaleRead)) {
        console.warn("[prime] small tables refresh failed; keeping the rows held:", e instanceof Error ? e.message : e);
      }
    }
  }
  const db = state.snapshot!;

  // ── Applications, and the people on them ──────────────────────────────────
  const wanted = new Set<Id>(scope.candidateIds ?? []);

  if ((scope.allApplications || scope.followUps) && now - state.allAt > ttl) {
    const w = state.writes;
    try {
      const { applications } = await backend.allApplications(actor);
      // Overtaken by a save: installed only if nothing is held yet (a page
      // cannot render without it), and never marked fresh.
      const settled = state.writes === w;
      if (settled || state.allAt === 0) {
        // Replaced, not merged: an application that moved stage or was removed
        // must not survive as its old self.
        db.applications = applications;
      }
      if (settled) {
        state.allAt = now;
        for (const o of db.openings) state.openings.set(o.id, now);
      }
    } catch (e) {
      if (state.allAt === 0) throw e;
    }
  } else if (scope.openingId && now - (state.openings.get(scope.openingId) ?? 0) > TABLES_TTL_MS) {
    const openingId = scope.openingId;
    const w = state.writes;
    const [apps, detail] = await Promise.all([
      backend.applications(actor, openingId),
      backend.opening(actor, openingId),
    ]);
    // Overtaken by a save: what is held has it, so keep that and leave the
    // opening due for the next page — unless this is its first read.
    const settled = state.writes === w;
    if (settled) state.openings.set(openingId, now);
    if (settled || !db.applications.some((a) => a.openingId === openingId)) {
      db.applications = [...db.applications.filter((a) => a.openingId !== openingId), ...apps];
      // Posts and assignments come with the whole tables above, with their real
      // ids. But the opening itself must be here even when that list is not:
      // a refresh of the small tables that fails keeps the older list, and a
      // just-created opening was then missing from it — Save job went straight
      // to a 404 for an opening that had been saved (testing, 21 Sep). The
      // opening was fetched on its own anyway; it is now kept.
      if (detail) {
        db.openings = [detail.opening, ...db.openings.filter((o) => o.id !== detail.opening.id)];
        const known = new Set(db.jobPosts.map((p) => p.id));
        db.jobPosts = [...db.jobPosts, ...detail.posts.filter((p) => !known.has(p.id))];
        state.version++;
      }
    }
  }

  /*
   * Whose candidate records to fetch.
   *
   * The people on a NAMED opening, because that page lists them by name — and
   * anyone asked for outright. Not everybody on every application: the
   * dashboards ask for all 8,378 applications to count stages, and pulling
   * 8,378 candidate records to do it would make the slowest page on the desk
   * out of one that only needed numbers.
   */
  if (scope.openingId) {
    for (const a of db.applications) {
      if (a.openingId === scope.openingId) wanted.add(a.candidateId);
    }
  }
  /*
   * The alerts name people, and the root layout computes them on every page
   * for the badge. They read candidates on the active alert stages and recent review rounds.
   */
  if (scope.followUps) {
    for (const a of db.applications) {
      if (ALERT_STAGES.has(a.stage)) wanted.add(a.candidateId);
    }
    for (const r of db.reviewRounds) {
      if (now - (r.returnedAt ?? r.sentAt) <= 3 * 86_400_000) {
        for (const appId of r.applicationIds) {
          const a = db.applications.find((x) => x.id === appId);
          if (a) wanted.add(a.candidateId);
        }
      }
    }
  }
  const stale = [...wanted].filter((id) => now - (state.candidates.get(id) ?? 0) > CANDIDATE_TTL_MS);
  const wc = state.writes;
  if (stale.length > 0) {
    const people = await backend.candidatesByIds(actor, stale);
    // Candidates a page needs are installed even after a save (a page cannot
    // render without them), but not marked fresh, so the next page reads them
    // again rather than trusting rows that may predate the save.
    const settled = state.writes === wc;
    const fresh: Candidate[] = [];
    for (const id of stale) {
      // Remembered even when absent, so a deleted row is not chased forever
      // and a genuine miss can still be told from a page that never asked.
      state.candidates.set(id, settled ? now : 1);
      const c = people.get(id);
      if (c) fresh.push(c);
    }
    const gone = new Set(stale.filter((id) => !people.has(id)));
    db.candidates = merge(
      db.candidates.filter((c) => !gone.has(c.id)),
      fresh,
      (c) => c.id,
    );
    // Their referees, which the reference page and follow-up read by candidate.
    const refs = await convexQuery<Database["referees"]>("ta/tables:refereesFor", { candidateIds: stale });
    const refreshed = new Set(stale);
    db.referees = [...db.referees.filter((r) => !refreshed.has(r.fromCandidateId)), ...refs];
  }

  // Let go of people nobody has asked for in ten minutes.
  const evict = [...state.candidates].filter(([id, at]) => now - at > CANDIDATE_EVICT_MS && !wanted.has(id));
  if (evict.length > 0) {
    const out = new Set(evict.map(([id]) => id));
    for (const id of out) state.candidates.delete(id);
    db.candidates = db.candidates.filter((c) => !out.has(c.id));
  }
  state.version++;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Tables loaded whole, through ta/tables:page — the TA System's own records. */
const WHOLE_TABLES = [
  "briefs", "jobPosts", "assignments", "pipelineEvents", "reviewRounds", "linkVault", "alerts",
  "savedSearches", "savedReports", "researchReports", "benchmarks", "suggestions", "chat", "jdChat", "intake",
  "outreach", "offers", "placements", "esaRecords", "aiCalls", "settings", "matchRuns",
  "matchExclusions", "callFeedback", "interviews",
] as const;

async function loadWholeTables(): Promise<Partial<Database>> {
  const chunkSize = 3;
  const entries: (readonly [string, unknown[]])[] = [];
  for (let i = 0; i < WHOLE_TABLES.length; i += chunkSize) {
    const chunk = WHOLE_TABLES.slice(i, i + chunkSize);
    const chunkEntries = await Promise.all(
      chunk.map(async (table) => {
        const rows: unknown[] = [];
        let cursor: string | null = null;
        // A page that runs past the backend's one-second query limit is asked
        // for again at half the size, rather than failing the whole page load.
        let numItems = 1000;
        for (let pages = 0; pages < 400; pages++) {
          let page: { rows: unknown[]; isDone: boolean; continueCursor: string | null };
          try {
            page = await convexQuery("ta/tables:page", { table, cursor, numItems });
          } catch (e) {
            if (numItems <= 50 || !/timed out|Server Error|fetch failed/i.test((e as Error).message)) throw e;
            numItems = Math.floor(numItems / 2);
            pages--;
            continue;
          }
          rows.push(...page.rows);
          if (page.isDone || !page.continueCursor) break;
          cursor = page.continueCursor;
        }
        return [table, rows] as const;
      }),
    );
    entries.push(...chunkEntries);
  }
  return Object.fromEntries(entries) as Partial<Database>;
}

/** Stages whose people `computeAlerts` reads by name (src/lib/sla.ts). */
const ALERT_STAGES = new Set<Application["stage"]>([
  "ai_follow_up",
  "ta_follow_up",
  "director_review",
  "director_shortlist",
  "client_shortlist",
  "interview",
  "offer",
  "placed",
]);

function merge<T>(have: T[], incoming: T[], key: (x: T) => string): T[] {
  if (incoming.length === 0) return have;
  const byKey = new Map(have.map((x) => [key(x), x]));
  for (const x of incoming) byKey.set(key(x), x);
  return [...byKey.values()];
}

