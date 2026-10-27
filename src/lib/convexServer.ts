import "server-only";

/**
 * Calling the Convex backend from this app's server, as a named person.
 *
 * Separate from `src/lib/convex.ts`, which is the browser client and carries
 * no credential. This one holds the deployment's admin key, so it must never
 * be imported into a client component — `server-only` makes that a build
 * error rather than a leak.
 *
 * Why the admin key and not a user token: this app signs people in with its
 * own cookie, so there is no Clerk identity to forward. The backend's
 * dual-mode adapter (convex/lib/auth.ts) accepts an explicit `actorId`
 * instead, and the admin key is what is permitted to supply one. The key
 * therefore establishes that the CALLER is this server; `actorId` establishes
 * WHO the server is acting for. Authorization — whether that person may do the
 * thing — is decided before we get here, by `src/lib/auth.ts`.
 */

import { backendHostAllowed } from "./convexHost";
import { Breaker, Gate, ReadCache, backoffMs } from "./convexResilience";

const TIMING = !!process.env.C141_TIMING;

export class ConvexCallError extends Error {
  readonly status?: number;
  /** The connection itself failed — the only failure that says the backend is down. */
  readonly unreachable: boolean;
  constructor(message: string, status?: number, unreachable = false) {
    super(message);
    this.status = status;
    this.unreachable = unreachable;
  }
}

/** The backend's URL and admin key, after the loopback check. Server code only. */
export function convexConfig(): { url: string; adminKey: string } {
  return config();
}

function config(): { url: string; adminKey: string } {
  const url = (process.env.CONVEX_SELF_HOSTED_URL || process.env.CONVEX_URL || "").trim().replace(/\/+$/, "");
  const adminKey = (process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "").trim();
  if (!url) throw new ConvexCallError("No Convex URL is configured (CONVEX_SELF_HOSTED_URL or CONVEX_URL).");
  if (!adminKey) throw new ConvexCallError("No Convex admin key is configured (CONVEX_SELF_HOSTED_ADMIN_KEY).");

  // The same refusal the CLI wrapper makes, for the same reason: production
  // and the local backend differ only by this string, and an admin key aimed
  // at the wrong one writes to the wrong database. See ./convexHost.ts for the
  // one deliberate exception: a production deployment naming its own backend.
  const verdict = backendHostAllowed(url, {
    deployment: process.env.C141_DEPLOYMENT,
    allowedHost: process.env.C141_CONVEX_HOST,
  });
  if (!verdict.ok) throw new ConvexCallError(verdict.message);

  return { url, adminKey };
}

type Kind = "query" | "mutation" | "action";

/*
 * How long a READ may take before it is given up (28 Sep).
 *
 * There was no limit. Page loads queue behind one another in primeStore, so one
 * query the backend never answered froze every page for everyone, with no
 * error to show. Reads only: a mutation or action abandoned here may still
 * finish on the backend, and the caller retrying it would do it twice.
 * The biggest read, every application, takes a few seconds; 30 is far past it.
 */
const QUERY_TIMEOUT_MS = Number(process.env.C141_QUERY_TIMEOUT_MS ?? "") || 30_000;

/*
 * Shared by every call from this process (26 Oct): identical reads share one
 * request, at most BACKEND_CONCURRENCY queries and mutations are out at once,
 * and a backend that has stopped answering is left alone for a few seconds.
 * Actions are not gated — a CV reading holds its place for minutes and would
 * starve the reads the desk is waiting on.
 */
const BACKEND_CONCURRENCY = Number(process.env.C141_BACKEND_CONCURRENCY ?? "") || 16;
const reads = new ReadCache();
const gate = new Gate(BACKEND_CONCURRENCY);
const breaker = new Breaker();

async function call<T>(kind: Kind, path: string, args: Record<string, unknown>): Promise<T> {
  const wait = breaker.blockedFor();
  if (wait) throw new ConvexCallError(`The backend is not answering, so calls are paused for ${wait} more seconds.`, 503);
  try {
    const out = await (kind === "action" ? send<T>(kind, path, args) : gate.run(() => send<T>(kind, path, args)));
    // The backend answered, even if with a refusal.
    breaker.success();
    return out;
  } catch (e) {
    // Only a connection that fails says the backend is down. A refusal, a
    // missing key or one slow query timing out says nothing about the rest, and
    // must not pause every other page.
    if (e instanceof ConvexCallError) {
      if (e.unreachable || e.status === 502 || e.status === 503 || e.status === 504) breaker.failure();
      else if (e.status !== undefined) breaker.success();
    }
    throw e;
  } finally {
    // A write may have changed anything a held read says.
    if (kind !== "query") reads.clear();
  }
}

async function send<T>(kind: Kind, path: string, args: Record<string, unknown>): Promise<T> {
  const { url, adminKey } = config();

  // C141_TIMING=1 logs each backend call's path, duration and response size —
  // the first thing to read when a page feels slow. Off by default.
  const started = TIMING ? performance.now() : 0;
  let res: Response;
  try {
    res = await fetch(`${url}/api/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Convex ${adminKey}`,
      },
      body: JSON.stringify({ path, args, format: "json" }),
      cache: "no-store",
      signal: kind === "query" ? AbortSignal.timeout(QUERY_TIMEOUT_MS) : undefined,
    });
  } catch (e) {
    // Next.js signals "this page must render per request" by THROWING from
    // fetch during the build (an error carrying a `digest`). Wrapping it turned
    // that signal into a connection error, and `next build` failed on the first
    // page that loads data. Control-flow errors pass through untouched.
    if (e && typeof e === "object" && "digest" in e) throw e;
    const err = e as Error;
    // Worded so RETRYABLE below does not match it: four more waits of the same
    // length would be two minutes of a frozen desk.
    if (err.name === "TimeoutError") {
      throw new ConvexCallError(`The backend did not answer ${path} within ${Math.round(QUERY_TIMEOUT_MS / 1000)} seconds.`);
    }
    const cause = (err as unknown as { cause?: Error | string })?.cause;
    const causeMsg = cause ? ` - ${typeof cause === "object" && "message" in cause ? cause.message : cause}` : "";
    throw new ConvexCallError(`Could not reach the Convex backend (${err.message}${causeMsg}).`, undefined, true);
  }

  const raw = await res.text().catch(() => "");
  if (TIMING) {
    console.log(`[convex] ${kind} ${path} ${Math.round(performance.now() - started)}ms ${Math.round(raw.length / 1024)}KB`);
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const body = parsed as { status?: string; value?: T; errorMessage?: string; message?: string; error?: string } | null;

  if (!res.ok || !body || body.status !== "success") {
    // The server's message only. The request carries the admin key and must
    // never appear in a log or an error a user can see.
    const detail =
      body?.errorMessage ||
      body?.message ||
      body?.error ||
      (!body && raw ? `Invalid JSON response: ${raw.slice(0, 100)}` : `HTTP ${res.status}`);
    throw new ConvexCallError(`Convex refused ${path}: ${detail.slice(0, 300)}`, res.status);
  }
  return body.value as T;
}

const RETRYABLE = /timed out|fetch failed|econnreset|etimedout|eai_again|socket hang up|network|invalid json response|http 429|http 502|http 503|http 504/i;

/**
 * `cacheMs`: how stale this answer may be. Left out, the read is fresh (though
 * identical reads at the same moment still share one request). Any write this
 * process makes drops what is held.
 */
export async function convexQuery<T>(path: string, args: Record<string, unknown> = {}, opts: { cacheMs?: number } = {}): Promise<T> {
  return reads.get<T>(ReadCache.key(path, args), async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call<T>("query", path, args);
      } catch (e) {
        if (attempt >= 4 || !(e instanceof ConvexCallError) || !RETRYABLE.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }
  }, opts.cacheMs);
}

export const convexMutation = <T>(path: string, args: Record<string, unknown> = {}) =>
  call<T>("mutation", path, args);

export const convexAction = <T>(path: string, args: Record<string, unknown> = {}) =>
  call<T>("action", path, args);

/**
 * A storage upload address, pointed at the backend this server already talks to.
 *
 * `generateUploadUrl` answers with the backend's public address
 * (api.career141.com). From inside the app's container that address did not
 * answer — a spoken brief's audio was lost with "fetch failed" (21 Sep) — while
 * the internal one (CONVEX_SELF_HOSTED_URL) always does. Same path and token;
 * only where it is sent changes.
 */
export function internalUploadUrl(url: string): string {
  try {
    const target = new URL(url);
    // Only rewrite Convex storage URLs, never external Cloudflare R2 or AWS S3 URLs
    if (
      target.hostname.includes("r2.cloudflarestorage.com") ||
      target.hostname.includes(".r2.dev") ||
      target.hostname.includes("amazonaws.com")
    ) {
      return url;
    }
    const inside = new URL(config().url);
    target.protocol = inside.protocol;
    target.hostname = inside.hostname;
    target.port = inside.port;
    return target.toString();
  } catch {
    return url;
  }
}

// ─── The actor bridge ────────────────────────────────────────────────────────

export interface ConvexActor {
  _id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  isOnboarded: boolean;
}

/**
 * This deployment's user for one of ours, matched on email.
 *
 * Null means the person signed into this app has no account in the backend
 * yet. That is a state to show, not to work around: acting anyway would record
 * their work against nobody.
 */
export function convexActorForEmail(email: string): Promise<ConvexActor | null> {
  return convexQuery<ConvexActor | null>("ta/actor:lookupByEmail", { email });
}
