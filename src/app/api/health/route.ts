import { convexQuery } from "@/lib/convexServer";
import { searxngInstances } from "@/lib/serper";

/**
 * Is the app able to do its job — for Docker's healthcheck and an outside
 * uptime monitor.
 *
 * The healthcheck used to load /signin (28 Sep). That page renders even when
 * Qdrant or SearXNG is down, so "healthy" said nothing about matching or
 * search, and it cost a full page render every 30 seconds.
 *
 * 503 only when the database cannot be read: without it no page works, and
 * that is what the release pipeline must refuse a new image for. Qdrant and
 * SearXNG failing is "degraded" with a 200 — matching and web search stop, the
 * desk still works, and rolling back a good image would not bring them back.
 *
 * The body says which part failed and how long each took, never why: this URL
 * is public, and the reasons carry internal addresses. The reasons go to the
 * server log.
 */
export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 5_000;

async function check(name: string, run: () => Promise<unknown>) {
  const started = performance.now();
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS)),
    ]);
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (e) {
    console.error(`[health] ${name} failed: ${(e as Error).message}`);
    return { ok: false, ms: Math.round(performance.now() - started) };
  }
}

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function GET() {
  const qdrant = (process.env.QDRANT_URL ?? "").trim().replace(/\/+$/, "");
  const qdrantKey = (process.env.QDRANT_API_KEY ?? "").trim();
  const searxng = searxngInstances()[0];

  const [database, vectors, search] = await Promise.all([
    check("database", () => convexQuery("health:ping")),
    qdrant ? check("qdrant", () => get(`${qdrant}/healthz`, qdrantKey ? { "api-key": qdrantKey } : {})) : null,
    searxng ? check("searxng", () => get(`${searxng}/healthz`)) : null,
  ]);

  const checks = { database, ...(vectors && { vectors }), ...(search && { search }) };
  const status = !database.ok ? "down" : Object.values(checks).every((c) => c.ok) ? "ok" : "degraded";
  return Response.json(
    { status, checks, uptimeSeconds: Math.round(process.uptime()) },
    { status: status === "down" ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}
