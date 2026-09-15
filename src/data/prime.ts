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
import { blank, state } from "@/data/primeState";

export { primed, hasCandidate, missingCandidateMessage, resetStore } from "@/data/primeState";

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
export async function primeStore(scope: PrimeScope = {}): Promise<void> {
  if (!isConvex()) return;

  const fresh = state.snapshot === null;
  if (fresh) {
    state.snapshot = blank();
    state.candidates = new Set();
    state.openings = new Set();
    state.all = false;
  }
  const db = state.snapshot!;
  const actor = { id: null as string | null };

  // ── The small tables, once ────────────────────────────────────────────────
  if (fresh) {
    const [users, openings, clients] = await Promise.all([
      backend.users(actor),
      backend.openings(actor),
      backend.clients(actor).catch(() => []),
    ]);
    db.users = users;
    db.openings = openings;
    // Real rows once the backfill has run. Before that they are derived from
    // the openings, so the app works on a database that has only been
    // restored — the fallback is a bridge, not a second source of truth.
    db.clients = clients.length > 0 ? clients : clientsFrom(openings);
  }

  // ── Applications, and the people on them ──────────────────────────────────
  const wanted = new Set<Id>(scope.candidateIds ?? []);

  if (scope.allApplications && !state.all) {
    state.all = true;
    const { applications } = await backend.allApplications(actor);
    db.applications = merge(db.applications, applications, (a) => a.id);
    for (const o of db.openings) state.openings.add(o.id);
  } else if (scope.openingId && !state.openings.has(scope.openingId)) {
    const openingId = scope.openingId;
    state.openings.add(openingId);
    const [apps, detail] = await Promise.all([
      backend.applications(actor, openingId),
      backend.opening(actor, openingId),
    ]);
    db.applications = merge(db.applications, apps, (a) => a.id);
    if (detail) {
      db.jobPosts = merge(db.jobPosts, detail.posts, (p) => p.id);
      db.assignments = merge(
        db.assignments,
        detail.assignments.map((a, i) => ({
          id: `${openingId}:${a.userId}:${i}`,
          openingId,
          userId: a.userId,
          role: a.role as never,
          assignedAt: 0,
          assignedBy: null,
        })),
        (a) => a.id,
      );
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
   * The alerts, though, name people — and the root layout computes them on
   * every page for the badge. They only read candidates on the late stages
   * (follow-up chases, interviews, offers, joining), which is a few hundred
   * rather than the whole desk, so those come along with `allApplications`.
   */
  if (scope.allApplications) {
    for (const a of db.applications) {
      if (ALERT_STAGES.has(a.stage)) wanted.add(a.candidateId);
    }
  }
  const missing = [...wanted].filter((id) => !state.candidates.has(id));
  if (missing.length > 0) {
    const people = await backend.candidatesByIds(actor, missing);
    const added: Candidate[] = [];
    for (const id of missing) {
      // Remembered even when absent, so a deleted row is not chased forever
      // and a genuine miss can still be told from a page that never asked.
      state.candidates.add(id);
      const c = people.get(id);
      if (c) added.push(c);
    }
    db.candidates = merge(db.candidates, added, (c) => c.id);
  }
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
