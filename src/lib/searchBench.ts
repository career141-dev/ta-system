import type { SearchResult } from "./serper";
import { clientQueries, pickLinkedInCompany, pickOfficialSite } from "./researchSearch";

/**
 * The search benchmark — 24 Sep, at the owner's request: measure Claude's web
 * search against the engine behind it (SearXNG) on the searches Research
 * actually makes, before and after switching Claude on.
 *
 * Each engine gets the same six queries (researchSearch.clientQueries) for
 * one client. What is scored is what Research needs from them: did it answer,
 * how fast, how much came back, did it find the client's own website and its
 * LinkedIn page, how far the two engines agree — and, for Claude, how many
 * addresses its reply named that its search had not returned.
 */
export interface BenchInput {
  client: string;
  industry: string;
  where: string;
  title: string;
}

export type Engine = (q: string) => Promise<SearchResult>;

interface Row {
  ms: number;
  hits: number;
  error: string | null;
  top: string[];
  ungrounded: number;
}

export interface EngineScore {
  /** Queries that came back with at least one result, of those asked. */
  answered: string;
  medianMs: number;
  slowestMs: number;
  averageHits: number;
  /** The client's own site, as Research would pick it; null when not found. */
  officialSite: string | null;
  linkedinPage: string | null;
  /** Claude only: addresses it named that its search had not returned. */
  ungrounded: number;
  errors: string[];
}

export interface BenchResult {
  input: BenchInput;
  summary: Record<string, EngineScore>;
  /** Share of result hosts both engines found, per query, 0–1. */
  agreement: number;
  queries: { query: string; results: Record<string, Row>; sharedHosts: number }[];
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

async function timed(engine: Engine, q: string): Promise<{ row: Row; result: SearchResult }> {
  const t = Date.now();
  let result: SearchResult;
  try {
    result = await engine(q);
  } catch (e) {
    result = { hits: [], credits: 0, error: String(e) };
  }
  const row: Row = {
    ms: Date.now() - t,
    hits: result.hits.length,
    error: result.error ?? null,
    top: result.hits.slice(0, 3).map((h) => h.url),
    ungrounded: result.ungrounded ?? 0,
  };
  return { row, result };
}

export async function benchmarkSearch(input: BenchInput, engines: Record<string, Engine>): Promise<BenchResult> {
  const names = Object.keys(engines);
  const queries = clientQueries(input.client, input.industry, input.where, input.title);
  const rows: BenchResult["queries"] = [];
  const found: Record<string, SearchResult[]> = Object.fromEntries(names.map((n) => [n, []]));

  // One query at a time, the engines side by side: a fair race, and never
  // more Claude processes at once than one per engine.
  for (const query of queries) {
    const answers = await Promise.all(names.map((n) => timed(engines[n], query)));
    const results: Record<string, Row> = {};
    answers.forEach((a, i) => {
      results[names[i]] = a.row;
      found[names[i]].push(a.result);
    });
    const hostSets = answers.map((a) => new Set(a.result.hits.map((h) => host(h.url))));
    const union = new Set(hostSets.flatMap((s) => [...s]));
    const shared = [...union].filter((h) => hostSets.every((s) => s.has(h))).length;
    rows.push({ query, results, sharedHosts: union.size ? shared / union.size : 0 });
  }

  const summary: Record<string, EngineScore> = {};
  for (const n of names) {
    const r = rows.map((q) => q.results[n]);
    const ms = r.map((x) => x.ms).sort((a, b) => a - b);
    const res = found[n];
    // Research picks the site from queries 1 and 3, the LinkedIn page from 2 and 1.
    summary[n] = {
      answered: `${r.filter((x) => x.hits > 0).length}/${r.length}`,
      medianMs: ms[Math.floor(ms.length / 2)] ?? 0,
      slowestMs: ms[ms.length - 1] ?? 0,
      averageHits: Math.round((r.reduce((s, x) => s + x.hits, 0) / (r.length || 1)) * 10) / 10,
      officialSite: pickOfficialSite([...(res[0]?.hits ?? []), ...(res[2]?.hits ?? [])], input.client),
      linkedinPage: pickLinkedInCompany([...(res[1]?.hits ?? []), ...(res[0]?.hits ?? [])], input.client),
      ungrounded: r.reduce((s, x) => s + x.ungrounded, 0),
      errors: r.map((x) => x.error).filter((e): e is string => Boolean(e)),
    };
  }
  const agreement = rows.length ? Math.round((rows.reduce((s, q) => s + q.sharedHosts, 0) / rows.length) * 100) / 100 : 0;
  return { input, summary, agreement, queries: rows };
}
