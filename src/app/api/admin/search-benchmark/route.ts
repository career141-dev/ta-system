import { primeStore } from "@/data/prime";
import { currentUser } from "@/lib/session";
import { claudeSearchEnabled, claudeWebSearch } from "@/lib/claudeSub";
import { searchEngine, searchProvider } from "@/lib/serper";
import { benchmarkSearch, type Engine } from "@/lib/searchBench";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/search-benchmark?client=Hayleys PLC&industry=Conglomerate
 *
 * Claude's web search against the engine behind it, on the six searches a
 * Research run starts with (lib/searchBench). Admins only: every press spends
 * six searches of the owner's Claude subscription. Works whether or not
 * Claude search is switched on for the desk, so it can be measured first.
 */
export async function GET(req: Request) {
  await primeStore();
  const user = await currentUser();
  if (!user || !user.isActive) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (user.role !== "admin") return Response.json({ error: "Only an admin can run the search benchmark." }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const input = {
    client: (p.get("client") ?? "Hayleys PLC").trim(),
    industry: (p.get("industry") ?? "").trim(),
    where: (p.get("where") ?? "Sri Lanka").trim(),
    title: (p.get("title") ?? "Finance Manager").trim(),
  };

  const engines: Record<string, Engine> = {};
  if ((process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) engines.claude = (q) => claudeWebSearch(q, 10);
  const engine = searchProvider();
  if (engine) engines[engine] = (q) => searchEngine(q, 10);
  if (!Object.keys(engines).length) return Response.json({ error: "No search is set up: no Claude token and no search engine." }, { status: 503 });

  const result = await benchmarkSearch(input, engines);
  return Response.json({ claudeSearchOnForTheDesk: claudeSearchEnabled(), ...result }, { headers: { "cache-control": "no-store" } });
}
