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

const TIMING = !!process.env.C141_TIMING;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export class ConvexCallError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
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
  // at the wrong one writes to the wrong database. Lift this deliberately when
  // there is a reason to, not by editing an env file.
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ConvexCallError(`The Convex URL is not a URL: ${url}`);
  }
  if (!LOOPBACK.has(host)) {
    throw new ConvexCallError(
      `Refusing to call ${host}: this build may only talk to a Convex backend on this machine.`,
    );
  }

  return { url, adminKey };
}

type Kind = "query" | "mutation" | "action";

async function call<T>(kind: Kind, path: string, args: Record<string, unknown>): Promise<T> {
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
    });
  } catch (e) {
    // Next.js signals "this page must render per request" by THROWING from
    // fetch during the build (an error carrying a `digest`). Wrapping it turned
    // that signal into a connection error, and `next build` failed on the first
    // page that loads data. Control-flow errors pass through untouched.
    if (e && typeof e === "object" && "digest" in e) throw e;
    throw new ConvexCallError(`Could not reach the Convex backend (${(e as Error).message}).`);
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
  const body = parsed as { status?: string; value?: T; errorMessage?: string } | null;

  if (!res.ok || !body || body.status !== "success") {
    // The server's message only. The request carries the admin key and must
    // never appear in a log or an error a user can see.
    const detail = body?.errorMessage ?? `HTTP ${res.status}`;
    throw new ConvexCallError(`Convex refused ${path}: ${detail.slice(0, 300)}`, res.status);
  }
  return body.value as T;
}

/**
 * Queries are read-only, so one that ran past the backend's one-second limit —
 * which happens on a cold cache after the backend restarts — is simply asked
 * again. Mutations and actions are never retried here.
 */
export async function convexQuery<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call<T>("query", path, args);
    } catch (e) {
      if (attempt >= 3 || !(e instanceof ConvexCallError) || !/timed out/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

export const convexMutation = <T>(path: string, args: Record<string, unknown> = {}) =>
  call<T>("mutation", path, args);

export const convexAction = <T>(path: string, args: Record<string, unknown> = {}) =>
  call<T>("action", path, args);

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
