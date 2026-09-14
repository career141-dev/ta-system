import "server-only";

/**
 * The Convex-backed data layer, in this platform's types.
 *
 * Every function here returns something from `src/data/types.ts` and nothing
 * from the backend's own shape, so `store.ts` above it never learns that its
 * rows come from Convex. That is what makes the swap a swap rather than a
 * rewrite of everything that reads a candidate.
 *
 * Two things this layer does NOT do, on purpose:
 *
 *   It does not decide who may see a row. Authorization is `src/lib/auth.ts`
 *   and `src/lib/visibility.ts`, above; the backend's own guard is below. A
 *   third opinion in the middle is how the three end up disagreeing.
 *
 *   It does not fetch whole tables that are large. `candidates` holds about
 *   77,000 rows, so there is deliberately no `allCandidates()` here — the
 *   patterns that used to read every row are named in the plan and are being
 *   replaced by Qdrant retrieval, not by a slower version of themselves.
 */

import { convexMutation, convexQuery } from "@/lib/convexServer";
import type { Application, Candidate, Client, Id, JobPost, Opening, User } from "@/data/types";
import {
  mapApplication,
  mapCandidateDoc,
  mapJobPost,
  mapOpening,
  mapUser,
  type BackendApplication,
  type BackendOpening,
  type BackendUser,
  type LiveCandidate,
  type MappedOpening,
} from "./map";

/**
 * Who the backend is told we are acting as.
 *
 * The TA platform's own user ids are not the backend's, so this is resolved
 * once per request from the session's email and passed down. `null` is a valid
 * state — some reads are open — but any write must carry one, or the backend
 * refuses it.
 */
export interface Actor {
  /** The backend's `users._id`. */
  id: string | null;
}

const NO_ACTOR: Actor = { id: null };

// ─── Users ───────────────────────────────────────────────────────────────────

export async function users(actor: Actor = NO_ACTOR): Promise<User[]> {
  const rows = await convexQuery<BackendUser[]>("ta/users:listTaUsers", {});
  return rows.map(mapUser).sort((a, b) => a.name.localeCompare(b.name));
}

/** The backend user for an email address, or null when they have no account
 *  there. Null is an answer to show, not one to work around — acting anyway
 *  would record the work against nobody. */
export async function actorForEmail(email: string): Promise<Actor & { user: User | null }> {
  const row = await convexQuery<BackendUser | null>("ta/actor:lookupByEmail", { email });
  return row ? { id: row._id, user: mapUser(row) } : { id: null, user: null };
}

// ─── Clients ─────────────────────────────────────────────────────────────────

/** The real client rows, written by the backfill. Empty before it has run —
 *  see prime.ts, which falls back to deriving them from the openings. */
export async function clients(actor: Actor): Promise<Client[]> {
  return convexQuery<Client[]>("ta/clients:list", { actorId: actor.id ?? undefined });
}

// ─── Openings ────────────────────────────────────────────────────────────────

export async function openings(actor: Actor, opts: { status?: string; mineOnly?: boolean } = {}): Promise<MappedOpening[]> {
  const rows = await convexQuery<BackendOpening[]>("ta/openings:list", {
    actorId: actor.id ?? undefined,
    status: opts.status,
    mineOnly: opts.mineOnly,
    limit: 500,
  });
  return rows.map(mapOpening);
}

export interface OpeningDetail {
  opening: Opening;
  posts: JobPost[];
  assignments: { userId: Id; role: string }[];
}

export async function opening(actor: Actor, openingId: Id): Promise<OpeningDetail | null> {
  const row = await convexQuery<
    (BackendOpening & { posts: unknown[]; assignments: { userId: string; role: string }[] }) | null
  >("ta/openings:get", { actorId: actor.id ?? undefined, openingId });
  if (!row) return null;
  return {
    opening: mapOpening(row),
    posts: (row.posts ?? []).map((p) => mapJobPost(p as never, openingId)),
    assignments: row.assignments ?? [],
  };
}

export async function approveJd(actor: Actor, openingId: Id, jdMarkdown?: string) {
  return convexMutation<{ ok: boolean; approvedBy: string }>("ta/openings:approveJd", {
    actorId: requireActorId(actor),
    openingId,
    jdMarkdown,
  });
}

// ─── Applications ────────────────────────────────────────────────────────────

export async function applications(
  actor: Actor,
  openingId: Id,
  stage?: string,
): Promise<Application[]> {
  const rows = await convexQuery<BackendApplication[]>("ta/applications:listForOpening", {
    actorId: actor.id ?? undefined,
    openingId,
    stage,
    limit: 1000,
  });
  return rows.map(mapApplication);
}

/**
 * Every application, paged.
 *
 * Convex caps a single query's array at 8,192 and the desk is past that, so
 * the cap is handled here rather than surfacing as a truncated list that looks
 * complete. `pages` is returned so a caller can see what it cost.
 */
export async function allApplications(actor: Actor): Promise<{ applications: Application[]; pages: number }> {
  const out: Application[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const res: { applications: BackendApplication[]; isDone: boolean; continueCursor: string | null } =
      await convexQuery("ta/applications:listAll", { actorId: actor.id ?? undefined, cursor });
    out.push(...res.applications.map(mapApplication));
    pages++;
    if (res.isDone || !res.continueCursor || pages > 50) break;
    cursor = res.continueCursor;
  }
  return { applications: out, pages };
}

export interface ApplicationDetail extends Application {
  /** What still has to be collected before Director Review will take them.
   *  Empty means the move will go through. Computed by the backend, which is
   *  where the rule lives. */
  directorReviewBlockers: string[];
}

export async function application(actor: Actor, applicationId: Id): Promise<ApplicationDetail | null> {
  const row = await convexQuery<(BackendApplication & { directorReviewBlockers: string[] }) | null>(
    "ta/applications:get",
    { actorId: actor.id ?? undefined, applicationId },
  );
  if (!row) return null;
  return { ...mapApplication(row), directorReviewBlockers: row.directorReviewBlockers ?? [] };
}

/**
 * The collision lock. Returns who won rather than throwing when somebody else
 * already owns them — two TAs reaching for the same person at the same moment
 * is ordinary desk life, and the loser needs to be told who to talk to.
 */
export async function shortlist(
  actor: Actor,
  applicationId: Id,
): Promise<{ ok: true; alreadyMine: boolean; setNumber: number | null } | { ok: false; ownerTaId: Id }> {
  return convexMutation("ta/applications:shortlist", {
    actorId: requireActorId(actor),
    applicationId,
  });
}

export async function moveStage(actor: Actor, applicationId: Id, stage: string, reason?: string) {
  return convexMutation<{ success: boolean; stage: string }>("ta/applications:moveStage", {
    actorId: requireActorId(actor),
    applicationId,
    stage,
    reason,
  });
}

// ─── Candidates ──────────────────────────────────────────────────────────────

export async function candidate(actor: Actor, candidateId: Id): Promise<Candidate | null> {
  const doc = await convexQuery<LiveCandidate | null>("ta/candidates:get", {
    actorId: actor.id ?? undefined,
    candidateId,
  });
  return doc ? mapCandidateDoc(doc) : null;
}

/**
 * Candidates by id, in one round trip.
 *
 * The batch exists because the alternative — a call per row while rendering a
 * list of fifty — is the shape that made the old system slow. Callers should
 * gather their ids first and ask once.
 */
export async function candidatesByIds(actor: Actor, ids: Id[]): Promise<Map<Id, Candidate>> {
  if (ids.length === 0) return new Map();
  const out = new Map<Id, Candidate>();
  // The backend caps a batch at 500; page rather than silently truncating.
  for (let i = 0; i < ids.length; i += 500) {
    const docs = await convexQuery<LiveCandidate[]>("ta/candidates:getBatch", {
      actorId: actor.id ?? undefined,
      candidateIds: ids.slice(i, i + 500),
    });
    for (const d of docs) out.set(d._id, mapCandidateDoc(d));
  }
  return out;
}

export type CvTextSource = "db" | "r2" | "none";

/**
 * CV text, and where it came from.
 *
 * `source` is the part that matters. Newer extractions write the text only to
 * R2, so a caller that treats "no text in the database" as "this person has no
 * CV" will score them on nothing and rank them last. `r2` means the text
 * exists and fetching it needs an action.
 */
export async function cvText(
  actor: Actor,
  ids: Id[],
): Promise<Map<Id, { source: CvTextSource; text: string | null; key: string | null }>> {
  const out = new Map<Id, { source: CvTextSource; text: string | null; key: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await convexQuery<
      { candidateId: string; source: CvTextSource; text: string | null; key: string | null }[]
    >("ta/candidates:cvText", {
      actorId: actor.id ?? undefined,
      candidateIds: ids.slice(i, i + 200),
    });
    for (const r of rows) out.set(r.candidateId, { source: r.source, text: r.text, key: r.key });
  }
  return out;
}

/** Every application this person has been on, across all openings — what the
 *  "rejected on a previous opening" warning is built from. */
export async function applicationsForCandidate(actor: Actor, candidateId: Id) {
  return convexQuery<
    {
      id: string;
      openingId: string;
      openingTitle: string;
      clientName: string | null;
      stage: string;
      ownerTaId: string | null;
      isActive: boolean;
      lastStageChangedAt: number;
    }[]
  >("ta/candidates:applicationsFor", { actorId: actor.id ?? undefined, candidateId });
}

// ─── Matching ────────────────────────────────────────────────────────────────

export async function matchRuns(actor: Actor, openingId: Id) {
  return convexQuery<
    {
      id: string;
      at: number;
      trigger: string;
      considered: number;
      afterRules: number;
      added: number;
      embedModel: string;
      assessmentVersion: string | null;
      note: string | null;
    }[]
  >("ta/matching:runsForOpening", { actorId: actor.id ?? undefined, openingId });
}

export async function matchExclusions(actor: Actor, openingId: Id): Promise<Set<Id>> {
  const rows = await convexQuery<{ candidateId: string; at: number }[]>(
    "ta/matching:exclusionsForOpening",
    { actorId: actor.id ?? undefined, openingId },
  );
  return new Set(rows.map((r) => r.candidateId));
}

// ─── Intake ──────────────────────────────────────────────────────────────────

export async function intakeCounts(actor: Actor) {
  return convexQuery<{ total: number; byStatus: Record<string, number> }>("ta/intake:counts", {
    actorId: actor.id ?? undefined,
  });
}

// ─── Guards ──────────────────────────────────────────────────────────────────

function requireActorId(actor: Actor): string {
  if (!actor.id) {
    throw new Error(
      "This write needs a backend account for the signed-in user, and there is none. " +
        "Run `node scripts/backfill-ta-users.mjs --write` to create them.",
    );
  }
  return actor.id;
}
