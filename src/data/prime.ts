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
import * as backend from "@/data/convex/backend";
import { blank, CANDIDATE_EVICT_MS, CANDIDATE_TTL_MS, primedVocabulary, state, TABLES_TTL_MS } from "@/data/primeState";

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
}

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
let loading: Promise<void> = Promise.resolve();

export function primeStore(scope: PrimeScope = {}): Promise<void> {
  if (!isConvex()) return Promise.resolve();
  // Queue behind whatever is in flight — including a failed one, whose
  // rejection must not cancel this caller's turn.
  const mine = loading.catch(() => {}).then(() => loadInto(scope));
  loading = mine.catch(() => {});
  return mine;
}

async function loadInto(scope: PrimeScope): Promise<void> {
  try {
    await refresh(scope);
  } finally {
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
  if (!state.snapshot || now - state.tablesAt > TABLES_TTL_MS) {
    try {
      const [users, openings, clients] = await Promise.all([
        backend.users(actor),
        backend.openings(actor),
        backend.clients(actor).catch(() => []),
      ]);
      // A backend that is still starting can answer with nothing rather than an
      // error. Nobody can sign in to a desk with no users, so that is a failed
      // read, not an answer.
      if (users.length === 0) throw new Error("The backend returned no users — it may still be starting.");
      const db = state.snapshot ?? blank();
      db.users = users;
      db.openings = openings;
      // Real rows once the backfill has run. Before that they are derived from
      // the openings, so the app works on a database that has only been
      // restored — the fallback is a bridge, not a second source of truth.
      db.clients = clients.length > 0 ? clients : clientsFrom(openings);
      state.snapshot = db;
      state.tablesAt = now;
    } catch (e) {
      if (!state.snapshot) throw e;
    }
  }
  const db = state.snapshot!;

  // ── Applications, and the people on them ──────────────────────────────────
  const wanted = new Set<Id>(scope.candidateIds ?? []);

  if ((scope.allApplications || scope.followUps) && now - state.allAt > TABLES_TTL_MS) {
    try {
      const { applications } = await backend.allApplications(actor);
      // Replaced, not merged: an application that moved stage or was removed
      // must not survive as its old self.
      db.applications = applications;
      state.allAt = now;
      for (const o of db.openings) state.openings.set(o.id, now);
    } catch (e) {
      if (state.allAt === 0) throw e;
    }
  } else if (scope.openingId && now - (state.openings.get(scope.openingId) ?? 0) > TABLES_TTL_MS) {
    const openingId = scope.openingId;
    const [apps, detail] = await Promise.all([
      backend.applications(actor, openingId),
      backend.opening(actor, openingId),
    ]);
    state.openings.set(openingId, now);
    db.applications = [...db.applications.filter((a) => a.openingId !== openingId), ...apps];
    if (detail) {
      db.jobPosts = merge(db.jobPosts, detail.posts, (p) => p.id);
      db.assignments = [
        ...db.assignments.filter((a) => a.openingId !== openingId),
        ...detail.assignments.map((a, i) => ({
          id: `${openingId}:${a.userId}:${i}`,
          openingId,
          userId: a.userId,
          role: a.role as never,
          assignedAt: 0,
          assignedBy: null,
        })),
      ];
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
   * for the badge. They read candidates on the late stages only — follow-up
   * chases, interviews, offers, joining — a few hundred, not the whole desk.
   */
  if (scope.followUps) {
    for (const a of db.applications) {
      if (ALERT_STAGES.has(a.stage)) wanted.add(a.candidateId);
    }
  }
  const stale = [...wanted].filter((id) => now - (state.candidates.get(id) ?? 0) > CANDIDATE_TTL_MS);
  if (stale.length > 0) {
    const people = await backend.candidatesByIds(actor, stale);
    const fresh: Candidate[] = [];
    for (const id of stale) {
      // Remembered even when absent, so a deleted row is not chased forever
      // and a genuine miss can still be told from a page that never asked.
      state.candidates.set(id, now);
      const c = people.get(id);
      if (c) fresh.push(c);
    }
    const gone = new Set(stale.filter((id) => !people.has(id)));
    db.candidates = merge(
      db.candidates.filter((c) => !gone.has(c.id)),
      fresh,
      (c) => c.id,
    );
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

/** Stages whose people `computeAlerts` reads by name (src/lib/sla.ts). */
const ALERT_STAGES = new Set<Application["stage"]>(["follow_up", "interview", "offer", "placed"]);

function merge<T>(have: T[], incoming: T[], key: (x: T) => string): T[] {
  if (incoming.length === 0) return have;
  const byKey = new Map(have.map((x) => [key(x), x]));
  for (const x of incoming) byKey.set(key(x), x);
  return [...byKey.values()];
}

/**
 * Clients, derived from the openings until the backfill gives them their own
 * table (plan step 5).
 *
 * The backend keeps `clientName` as free text, so "DirectFN" and "DIRECTFN"
 * are two spellings of one company. They fold together on a normalised key
 * here rather than showing as two clients — the same rule the backfill will
 * apply when it writes the real rows.
 */
function clientsFrom(openings: { clientId: string; clientName: string; clientIndustry: string; createdAt: number }[]): Database["clients"] {
  const byKey = new Map<string, Database["clients"][number]>();
  for (const o of openings) {
    const name = (o.clientName ?? "").trim();
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: o.clientId || `client:${key}`,
        name,
        industry: o.clientIndustry ?? "",
        contacts: [],
        esaSignedAt: null,
        status: "active",
        createdAt: o.createdAt,
      });
    }
  }
  return [...byKey.values()];
}
