/**
 * A read-only link to the current system's Convex backend (13 September).
 *
 * It can do exactly one thing: run a *query* function over Convex's HTTP API
 * (`POST /api/query`). Convex does not let a query write — saving needs a
 * mutation, which goes to a different endpoint this client has no way to call.
 * On top of that, only the query functions named in `READ_FUNCTIONS` can be
 * called at all, so a typo or a changed setting cannot reach anything else.
 *
 * It is gentle with a server that is already busy: one request at a time, a
 * few per second at most, small pages, and it backs off when told to.
 *
 * The key is the rotated admin key, read from the environment of the machine
 * this runs on. It is never logged, and never leaves this module except in the
 * Authorization header.
 */

/**
 * The only functions this link may call. Every one is a `query` in the current
 * system's code (read from source, 7 September commit) — never a mutation or an
 * action. Adding a name here is the only way to widen what it can read.
 */
export const READ_FUNCTIONS = {
  /** candidateResumes with an embedding, paged: candidateId, rawText, jobHistory, embedding. */
  resumesPage: "matching/queries:getPaginatedResumesWithEmbeddings",
  /** Full candidate documents by id. */
  candidatesByIds: "matching/queries:getCandidatesBatchPublic",
  /** Active and on-hold jobs: id, title, keyword, clientName, location (13 September). */
  activeJobs: "jobs/jobs:getActiveJobsBasicInfo",
  /** One job document by id or keyword: description, required skills, seniority, experience. */
  job: "jobs/jobs:getJob",
  /** The candidates who applied to a job, each carrying activeApplicationsSummary (job + stage) — the desk's real decisions, used to judge match quality. */
  applicantsForJob: "candidates/candidates:getCandidatesForJob",
  // Resource inventory (14 September). Each checked in source: a query or
  // internalQuery that only reads, returning counts, ids or job documents.
  /** internalQuery: one page of candidates, returned as a count only. */
  countCandidatesPage: "stats/statsQueries:getCandidatesPage",
  /** internalQuery: one page of CV uploads, count only. */
  countCvUploadsPage: "stats/statsQueries:getCvUploadsPage",
  /** internalQuery: one page of applications, count only. */
  countApplicationsPage: "stats/statsQueries:getApplicationsPage",
  /** internalQuery: one page of jobs, count and active count only. */
  countJobsPage: "stats/statsQueries:getJobsPage",
  /** query: job totals by status. */
  jobCounts: "jobs/jobs:getJobCounts",
  /** query: jobs of every status, paged, as full documents. */
  jobsPage: "jobs/jobs:listPaginated",
  /** query: ids only, 500 per page, from a named table. Despite its name it deletes nothing; the deleting function is separate and not listed. */
  idsPage: "candidates/candidates:fetchBatchForDeletion",
  /** query: one application document by id (stage, stage history, who shortlisted). */
  applicationById: "applications/applications:getApplication",
} as const;

const ALLOWED = new Set<string>(Object.values(READ_FUNCTIONS));

export type ReadFunction = (typeof READ_FUNCTIONS)[keyof typeof READ_FUNCTIONS];

export interface LiveConvexConfig {
  url: string;
  adminKey: string;
  /** Requests per second, at most. */
  rate?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export class LiveReadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function liveConvexConfigFromEnv(env = process.env): LiveConvexConfig | null {
  const url = (env.C141_LIVE_CONVEX_URL ?? "").trim().replace(/\/+$/, "");
  const adminKey = (env.C141_LIVE_CONVEX_ADMIN_KEY ?? "").trim();
  if (!url || !adminKey) return null;
  const rate = Number(env.C141_LIVE_READ_RATE ?? "");
  return { url, adminKey, rate: Number.isFinite(rate) && rate > 0 ? Math.min(rate, 10) : 3 };
}

export class ReadOnlyConvex {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly gapMs: number;
  private readonly config: LiveConvexConfig;
  requests = 0;

  constructor(config: LiveConvexConfig) {
    this.config = config;
    if (!/^https?:\/\//.test(config.url)) throw new LiveReadError("The live Convex URL must start with http:// or https://.");
    this.gapMs = Math.ceil(1000 / Math.max(0.1, Math.min(config.rate ?? 3, 10)));
  }

  /** Runs one allowed query. Serialised and paced; retried on 429 and 5xx. */
  query<T = unknown>(path: ReadFunction, args: Record<string, unknown>): Promise<T> {
    if (!ALLOWED.has(path)) {
      return Promise.reject(new LiveReadError(`"${path}" is not on the read-only list, so it was not called.`));
    }
    const run = this.queue.then(() => this.send<T>(path, args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send<T>(path: string, args: Record<string, unknown>): Promise<T> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const retries = this.config.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      this.requests++;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await doFetch(`${this.config.url}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Convex ${this.config.adminKey}` },
          body: JSON.stringify({ path, args, format: "json" }),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          continue;
        }
        throw new LiveReadError(`Could not reach the live system (${(e as Error).name}).`);
      }
      clearTimeout(timer);

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
        continue;
      }
      const body = (await res.json().catch(() => null)) as { status?: string; value?: T; errorMessage?: string } | null;
      if (!res.ok || !body || body.status !== "success") {
        // The server's message, never the request — the request carries the key.
        const msg = body?.errorMessage ?? `HTTP ${res.status}`;
        throw new LiveReadError(`The live system refused ${path}: ${msg.slice(0, 300)}`, res.status);
      }
      return body.value as T;
    }
  }
}
