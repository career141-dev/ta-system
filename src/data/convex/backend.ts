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

import { convexAction, convexMutation, convexQuery } from "@/lib/convexServer";
import { mapProfile, type CandidateProfile, type RawProfile } from "@/lib/candidateProfile";
import type { Application, BinItem, Candidate, Client, Id, JobPost, Opening, User } from "@/data/types";
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

export async function approveJd(actor: Actor, openingId: Id, jdMarkdown?: string, detailsFromJd = false) {
  return convexMutation<{ ok: boolean; approvedBy: string }>("ta/openings:approveJd", {
    actorId: requireActorId(actor),
    openingId,
    jdMarkdown,
    ...(detailsFromJd ? { detailsFromJd } : {}),
  });
}

export async function createOpening(
  actor: Actor,
  input: {
    clientId: string;
    title: string;
    country?: string;
    hiringFor?: string;
    targetGender?: string | null;
    jdMarkdown?: string;
    assignedTaIds: string[];
    taLeadId?: string | null;
    directorId?: string | null;
    notesMarkdown?: string;
    priorityTier?: string;
    autoFollowUp?: boolean;
  },
): Promise<string> {
  const res = await convexMutation<{ id: string }>("ta/openings:create", {
    actorId: requireActorId(actor),
    ...input,
  });
  return res.id;
}

/** The opening's automatic follow-up switch (convex/ta/followUp.ts `setAuto`). */
export async function setAutoFollowUp(actor: Actor, openingId: Id, enabled: boolean) {
  return convexMutation<{ ok: boolean; enabled: boolean; maxAttempts: number }>("ta/followUp:setAuto", {
    actorId: requireActorId(actor),
    openingId,
    enabled,
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

// ─── Reverse matching ────────────────────────────────────────────────────────

export interface ReverseMatchRow {
  cvId: string;
  overallScore: number;
  reason: string;
  matchedSkills?: string[];
  missingSkills?: string[];
  breakdown?: Record<string, number>;
  currentRoleGate?: string;
  roleFamilyMatch?: string;
  locationGate?: string;
  exclusionReason?: string | null;
}

/** What the engine last produced for an opening, without re-running it. */
export async function reverseMatchResults(
  actor: Actor,
  openingId: Id,
): Promise<{ status: string | null; matchedAt: string | null; results: ReverseMatchRow[] } | null> {
  return convexQuery("ta/matching:reverseMatchResults", {
    actorId: actor.id ?? undefined,
    openingId,
  });
}

/**
 * Run the tuned reverse-match engine and wait for it.
 *
 * `runReverseMatch` is an action that embeds the job, searches Qdrant, calls a
 * model to classify role families and writes its results onto the job — it
 * takes tens of seconds. It is triggered and then polled rather than awaited
 * in one call, because a request that blocks for a minute is a request that
 * times out somewhere between here and the browser.
 *
 * Returns what it found, or says plainly that it is still running. A caller
 * that cannot wait can come back to `reverseMatchResults`.
 */
export async function runReverseMatch(
  actor: Actor,
  openingId: Id,
  opts: { taPreferences?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; results: ReverseMatchRow[] } | { ok: false; reason: string }> {
  try {
    await convexMutation("jobs/jobs:triggerReverseMatch", {
      jobId: openingId,
      ...(opts.taPreferences !== undefined ? { customPreferences: opts.taPreferences } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `could not start: ${(e as Error).message}` };
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await reverseMatchResults(actor, openingId).catch(() => null);
    if (!res) continue;
    if (res.status === "done") return { ok: true, results: res.results };
    if (res.status === "error") return { ok: false, reason: "the matching engine reported an error" };
  }
  return { ok: false, reason: "still running — the results will appear when it finishes" };
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/**
 * Candidates matching words, from the backend's own full-text indexes.
 *
 * This is the half of retrieval that needs no model and no key: Convex search
 * indexes over titles, skills, summaries and CV text, merged and weighted by
 * where the hit landed. It is what makes search work at all when there is no
 * embedding to compare against, and it is the other route in a hybrid — a CV
 * that SAYS "Procurement Manager" is never hidden because its vector happened
 * to land under the bar.
 */
export async function keywordSearch(
  actor: Actor,
  query: string,
  limit = 100,
): Promise<{ candidateId: Id; score: number }[]> {
  if (!query.trim()) return [];
  return convexQuery<{ candidateId: Id; score: number }[]>("matching/search:searchCandidates", {
    query: query.slice(0, 300),
    limit,
  });
}

/** Several phrasings at once, merged, best score per person kept. */
export async function keywordSearchMany(
  actor: Actor,
  queries: string[],
  limitEach = 100,
): Promise<{ candidateId: Id; score: number }[]> {
  const terms = [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 2))].slice(0, 6);
  if (terms.length === 0) return [];
  const runs = await Promise.all(
    terms.map((t) => keywordSearch(actor, t, limitEach).catch(() => [] as { candidateId: Id; score: number }[])),
  );
  const best = new Map<Id, number>();
  for (const run of runs) {
    for (const hit of run) best.set(hit.candidateId, Math.max(best.get(hit.candidateId) ?? 0, hit.score));
  }
  return [...best].map(([candidateId, score]) => ({ candidateId, score })).sort((a, b) => b.score - a.score);
}

/** How many candidates there are, without reading any of them. */
export async function candidateStats(actor: Actor): Promise<{ total: number; sampled: boolean }> {
  return convexQuery<{ total: number; sampled: boolean }>("ta/candidates:stats", {
    actorId: actor.id ?? undefined,
  });
}

/** Titles, skills, cities and employers the database actually holds, sampled. */
export async function vocabulary(actor: Actor): Promise<{
  titles: { title: string; count: number }[];
  skills: string[];
  cities: string[];
  employers: string[];
  industries: string[];
  sampled: number;
}> {
  // One read every ten minutes, shared by the search parser and the Database
  // home — it samples 1,500 candidate rows and takes over a second, for words
  // that barely move. The actor does not change the answer.
  void actor;
  const now = Date.now();
  if (vocabularyCache && now - vocabularyCache.at < 10 * 60_000) return vocabularyCache.value;
  const value = convexQuery<Awaited<ReturnType<typeof vocabulary>>>("ta/candidates:vocabulary", {});
  vocabularyCache = { at: now, value };
  value.catch(() => {
    if (vocabularyCache?.value === value) vocabularyCache = null;
  });
  return value;
}

let vocabularyCache: { at: number; value: ReturnType<typeof vocabulary> } | null = null;

// ─── Candidates ──────────────────────────────────────────────────────────────

export async function candidate(actor: Actor, candidateId: Id): Promise<Candidate | null> {
  const directDoc = await convexQuery<LiveCandidate | null>("candidates/candidates:getCandidate", {
    id: candidateId,
  }).catch(() => null);

  const prof = !directDoc
    ? await convexQuery<LiveCandidate | null>("ta/candidates:profile", {
        actorId: actor.id ?? undefined,
        candidateId,
      }).catch(() => null)
    : null;

  const doc = directDoc ?? prof ?? (await convexQuery<LiveCandidate | null>("ta/candidates:get", {
    actorId: actor.id ?? undefined,
    candidateId,
  }).catch(() => null));

  if (!doc) return null;
  const mapped = mapCandidateDoc(doc);
  if (!mapped.cvFileName) {
    try {
      const found = await convexQuery<{ url: string | null; fileName?: string } | null>(
        "candidates/candidates:getCvUploadUrl",
        { cvUploadId: candidateId }
      );
      if (found && found.url) {
        mapped.cvFileName = found.fileName || "CV.pdf";
      }
    } catch {}
  }
  return mapped;
}

/**
 * Candidates by id, in one round trip.
 *
 * The batch exists because the alternative — a call per row while rendering a
 * list of fifty — is the shape that made the old system slow. Callers should
 * gather their ids first and ask once.
 */
export async function candidatesByIds(actor: Actor, ids: Id[]): Promise<Map<Id, Candidate>> {
  const out = new Map<Id, Candidate>();
  const docs = await candidateDocsByIds(actor, ids);

  const missingCvIds = docs.filter((d) => !d.cvFileName).map((d) => d._id);
  const cvNameMap = new Map<string, string>();
  if (missingCvIds.length > 0) {
    const chunkSize = 25;
    for (let i = 0; i < missingCvIds.length; i += chunkSize) {
      const chunk = missingCvIds.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (id) => {
          try {
            const found = await convexQuery<{ url: string | null; fileName?: string } | null>(
              "candidates/candidates:getCvUploadUrl",
              { cvUploadId: id }
            );
            if (found && found.url) {
              return { id, fileName: found.fileName || "CV.pdf" };
            }
          } catch {}
          return null;
        })
      );
      for (const r of results) {
        if (r && r.fileName) {
          cvNameMap.set(r.id, r.fileName);
        }
      }
    }
  }

  for (const d of docs) {
    const cand = mapCandidateDoc(d);
    if (!cand.cvFileName && cvNameMap.has(d._id)) {
      cand.cvFileName = cvNameMap.get(d._id)!;
    }
    out.set(d._id, cand);
  }
  return out;
}

/**
 * The same rows in the backend's own shape — for the matching engine's scorer
 * (convex/cvs/cvScoring), which reads fields the platform's type does not keep.
 */
export async function candidateDocsByIds(actor: Actor, ids: Id[]): Promise<LiveCandidate[]> {
  if (ids.length === 0) return [];
  const out: LiveCandidate[] = [];
  // The backend caps a batch at 500; page rather than silently truncating, and
  // send the pages together — they do not depend on each other, so waiting for
  // one before asking for the next only adds up the latencies.
  //
  // Pages of 200, four at a time: a page of 500 reads 1,000 documents (each
  // candidate and their résumé) and can run past the backend's one-second
  // limit, and several such pages at once make each other slower.
  const pages: Id[][] = [];
  for (let i = 0; i < ids.length; i += 200) pages.push(ids.slice(i, i + 200));
  for (let i = 0; i < pages.length; i += 4) {
    const results = await Promise.all(
      pages.slice(i, i + 4).map((page) =>
        convexQuery<LiveCandidate[]>("ta/candidates:getBatch", {
          actorId: actor.id ?? undefined,
          candidateIds: page,
        }),
      ),
    );
    for (const docs of results) out.push(...docs);
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

// ─── A candidate's full profile, and their CV ────────────────────────────────

/** Everything the database holds for one person — see `ta/candidates:profile`. */
export async function candidateProfile(actor: Actor, candidateId: Id): Promise<CandidateProfile | null> {
  const raw = await convexQuery<RawProfile | null>("ta/candidates:profile", {
    actorId: actor.id ?? undefined,
    candidateId,
  });
  return raw ? mapProfile(raw) : null;
}

export type CvLink =
  | { ok: true; url: string; fileName: string | null; fileType: string | null }
  | { ok: false; reason: "no_cv" | "file_missing" | "storage_unavailable"; detail: string; fileName: string | null };

/**
 * Where to open a candidate's CV, resolved the way the old system resolves it.
 *
 * `candidates/candidates:getCvUploadUrl` does the finding — upload by id, then
 * the candidate's upload, then an application's, then the file hash — and
 * answers with either a Convex storage URL or its own `/api/r2-file?key=…`
 * proxy path. That proxy path is the old app's route and does not exist here,
 * so the R2 key is taken out of it and signed directly with
 * `storage/r2:generateDownloadUrl`, which is what that route did.
 *
 * The key never reaches the browser and is never accepted FROM it: the old
 * route signed whatever key it was given, which let anyone signed in open any
 * object in the bucket. Here the only input is a candidate id, checked by the
 * caller against the person's access first.
 */
export async function cvLink(actor: Actor, candidateId: Id, download = false): Promise<CvLink> {
  const found = await findCvFile(candidateId);
  if (!found.ok) return found;
  const { fileName, fileType } = found;
  const proxied = found.url.match(/^\/api\/r2-file\?key=(.+)$/);
  if (!proxied) return { ok: true, url: found.url, fileName, fileType };

  try {
    const url = await convexAction<string>("storage/r2:generateDownloadUrl", {
      key: decodeURIComponent(proxied[1]),
      ...(download && fileName ? { downloadFilename: fileName.replace(/["\r\n]/g, "") } : {}),
    });
    return { ok: true, url, fileName, fileType };
  } catch (e) {
    const message = (e as Error).message;
    // The SDK's words for "nothing is configured" are about HTTP labels and
    // buckets; the person reading the profile needs to know it is a setting.
    const unconfigured = /Bucket|credential|access key|R2_/i.test(message);
    if (unconfigured) r2Checked = { at: Date.now(), configured: false };
    return {
      ok: false,
      reason: "storage_unavailable",
      detail: unconfigured
        ? unconfiguredDetail(fileName)
        : `${fileName ?? "The CV"} is stored in R2 and a link to it could not be made (${message}).`,
      fileName,
    };
  }
}

/**
 * Whether a candidate has a CV file that can be opened, and what it is — the
 * same lookup as `cvLink`, without signing a link. For a page deciding how to
 * show the CV before the browser asks for the file itself.
 */
export async function cvFile(
  candidateId: Id,
): Promise<{ ok: true; fileName: string | null; fileType: string | null } | Extract<CvLink, { ok: false }>> {
  const found = await findCvFile(candidateId);
  return found.ok ? { ok: true, fileName: found.fileName, fileType: found.fileType } : found;
}

async function findCvFile(
  candidateId: Id,
): Promise<{ ok: true; url: string; fileName: string | null; fileType: string | null } | Extract<CvLink, { ok: false }>> {
  const found = await convexQuery<{
    url: string | null;
    fileName?: string;
    fileType?: string;
    isMissingMigrationFile?: boolean;
    message?: string;
  } | null>("candidates/candidates:getCvUploadUrl", { cvUploadId: candidateId });

  if (!found) return { ok: false, reason: "no_cv", detail: "No CV file is on record for this candidate.", fileName: null };
  const fileName = found.fileName ?? null;
  if (!found.url) {
    // The backend's "Historical CV file pending Cloud to Self-Hosted migration"
    // told a TA nothing they could act on (28 Sep): say what happened and
    // what to do instead.
    const detail = found.isMissingMigrationFile
      ? `${fileName ?? "This CV"} was lost when the system moved to its new server and is being recovered. To use this candidate now, upload their CV again.`
      : "The CV is recorded but its file could not be found.";
    return { ok: false, reason: "file_missing", detail, fileName };
  }
  if (/^\/api\/r2-file\?key=/.test(found.url)) {
    // Asked, not tried: signing a link on a deployment without R2 fails inside
    // the backend and is logged there as an uncaught error on every profile
    // view. The answer is kept for five minutes either way.
    if (Date.now() - r2Checked.at > 5 * 60_000) {
      r2Checked = { at: Date.now(), configured: await convexQuery<boolean>("ta/storage:r2Configured", {}).catch(() => true) };
    }
    if (!r2Checked.configured) {
      return { ok: false, reason: "storage_unavailable", detail: unconfiguredDetail(fileName), fileName };
    }
  }
  return { ok: true, url: found.url, fileName, fileType: found.fileType ?? null };
}

let r2Checked = { at: 0, configured: true };
const unconfiguredDetail = (fileName: string | null) =>
  `${fileName ?? "The CV"} is stored in R2 file storage, which is not configured on this deployment (R2_BUCKET_NAME and its access keys are not set), so it cannot be opened here.`;

// ─── Mail intake (Settings → Mailboxes) ──────────────────────────────────────

export interface MailIntakeStatus {
  mailboxes: {
    mailbox: string;
    /** ta: a TA's own mailbox, read only for scoops (27 Sep). shortlist: shortlists@,
     *  where the Director's and the clients' shortlists arrive (29 Sep). */
    kind: "shared" | "ta" | "shortlist";
    taName: string | null;
    enabled: boolean;
    synced: boolean;
    backfillFrom: number;
    lastSyncAt: number | null;
    lastSyncError: string | null;
    totals: { seen: number; filed: number; database: number; duplicate: number; noCv: number; skipped: number; failed: number };
  }[];
  queue: { waiting: number; extracting: number };
  recent: {
    id: string;
    mailbox: string;
    receivedAt: number;
    subject: string;
    fromAddress: string;
    status: "waiting" | "processing" | "extracting" | "done";
    outcome: "filed" | "database" | "duplicate" | "no_cv" | "skipped" | "failed" | "held" | null;
    openings: { id: string; title: string }[];
    candidateIds: string[];
    note: string | null;
    error: string | null;
  }[];
}

/** The shared mailboxes the TA System reads, and what came in. Creates the mailbox rows on first use. */
export async function mailIntakeStatus(): Promise<MailIntakeStatus> {
  await convexMutation("mailIntake/model:ensureMailboxes", {});
  return convexQuery<MailIntakeStatus>("mailIntake/model:status", { limit: 50 });
}

export interface UnmatchedCv {
  candidateId: string;
  name: string | null;
  subject: string | null;
  note: string | null;
  source: string;
  from: string | null;
  receivedAt: number;
}

/** Mailbox CVs that matched no job post and are on no opening yet (convex/ta/unmatched.ts). */
export async function unmatchedCvs(days = 14): Promise<UnmatchedCv[]> {
  return convexQuery<UnmatchedCv[]>("ta/unmatched:list", { days });
}

export async function setMailboxEnabled(mailbox: string, enabled: boolean) {
  return convexMutation<{ ok: boolean }>("mailIntake/model:setEnabled", { mailbox, enabled });
}

export async function syncMailboxNow(mailbox: string) {
  return convexMutation<{ ok: boolean }>("mailIntake/model:syncNow", { mailbox });
}

// ─── Bin ─────────────────────────────────────────────────────────────────────

/** What is in the Bin (convex/ta/bin.ts), openings and clients together, newest first. */
export async function binItems(actor: Actor): Promise<BinItem[]> {
  const r = await convexQuery<{
    openings: { id: string; title: string; clientName: string | null; binnedAt: number; binnedBy: string | null; purgeAt: number }[];
    clients: { id: string; name: string; binnedAt: number; binnedBy: string | null; purgeAt: number }[];
  }>("ta/bin:list", { actorId: actor.id ?? undefined });
  return [
    ...r.openings.map((o): BinItem => ({ kind: "opening", id: o.id, name: o.title, clientName: o.clientName ?? null, binnedAt: o.binnedAt, binnedBy: o.binnedBy, purgeAt: o.purgeAt })),
    ...r.clients.map((c): BinItem => ({ kind: "client", id: c.id, name: c.name, clientName: null, binnedAt: c.binnedAt, binnedBy: c.binnedBy, purgeAt: c.purgeAt })),
  ].sort((a, b) => b.binnedAt - a.binnedAt);
}
