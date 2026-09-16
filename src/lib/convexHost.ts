/**
 * Which Convex backend this build may talk to.
 *
 * The admin key is unrestricted read and write, and production and a test copy
 * differ only by a URL in an environment file — so pointing the wrong one at
 * production writes to the real database. The rule is therefore: this machine
 * only, unless the deployment says plainly that it is production AND names the
 * host it expects.
 *
 * `C141_CONVEX_HOST` exists for one situation: the app runs in a container next
 * to the backend, where the backend is reachable as a service name (`backend`)
 * rather than on the loopback address. It is honoured only on a deployment that
 * has also set `C141_DEPLOYMENT=production`, so a test copy cannot reach a
 * remote backend by setting one variable.
 *
 * Pure, so it is tested on its own (tests/convexhost.test.ts) — no server-only
 * import, and no environment read of its own.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export type HostVerdict = { ok: true } | { ok: false; message: string };

export function backendHostAllowed(
  url: string,
  env: { deployment?: string; allowedHost?: string } = {},
): HostVerdict {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, message: `The Convex URL is not a URL: ${url}` };
  }
  if (LOOPBACK.has(host)) return { ok: true };

  const named = (env.allowedHost ?? "").trim().toLowerCase();
  if (env.deployment === "production" && named && named === host.toLowerCase()) return { ok: true };

  return {
    ok: false,
    message:
      `Refusing to call ${host}: this build may only talk to a Convex backend on this machine. ` +
      `On the production server, set C141_DEPLOYMENT=production and C141_CONVEX_HOST=${host} to allow it.`,
  };
}
