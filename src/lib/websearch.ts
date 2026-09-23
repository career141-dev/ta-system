/**
 * Google Boolean queries, answered by OpenAI's web search — 23 September.
 *
 * Research, Benchmark and Suggestions all write Google Boolean strings:
 * `site:linkedin.com/in "Chief Financial Officer" "Hayleys" -inurl:jobs`.
 * Serper hands those straight to Google, which understands every operator.
 * OpenAI's `web_search` tool does not: it reads the string as prose, so
 * `site:` and `-inurl:` came back as words to search for and the results were
 * whatever the model felt like. Pointing C141_SEARCH_PROVIDER at OpenAI
 * therefore "worked" while quietly returning the wrong pages.
 *
 * So the operators are taken out of the string and applied on our side: the
 * model is asked for the plain search, and everything it returns is then held
 * against the operators it was never told about. A `site:` that Google would
 * have enforced is enforced here by the address; `-inurl:jobs` throws the page
 * out after the fact. Fewer results than Google for the same query, but never
 * the wrong ones.
 *
 * The parallel matrix below is the other half: the scraper this was ported
 * from (SCRAPPER, Sept) fires ten to fifteen query angles at once and counts
 * how many of them turned up the same profile. That count is evidence — a
 * person found by six different angles is the person doing the job — and it
 * survives here as `hitCount`.
 */
import type { SearchHit } from "./serper";

/** A Google Boolean string, taken apart. */
export interface ParsedQuery {
  /** What to actually search for: the query with every operator removed. */
  text: string;
  /** `site:linkedin.com/in` — a hit must sit under one of these. Empty means anywhere. */
  sites: string[];
  /** `-inurl:jobs` — a hit whose address contains one of these is dropped. */
  notInUrl: string[];
  /** `-warehouse` — a hit whose title or snippet contains one of these is dropped. */
  notTerms: string[];
  /** The "quoted phrases", kept so the search can be told they matter. */
  phrases: string[];
}

const OPERATOR = /\b(?:site|inurl|intitle|intext|filetype|ext):\S+/gi;

export function parseBooleanQuery(q: string): ParsedQuery {
  const sites: string[] = [];
  const notInUrl: string[] = [];
  const notTerms: string[] = [];

  // Negatives first: `-inurl:jobs` is an operator with a minus in front of it,
  // and stripping the minus on its own would turn it into a positive filter.
  let rest = q.replace(/-\s*(?:inurl|intitle|intext):\s*"?([^\s")]+)"?/gi, (_m, w: string) => {
    notInUrl.push(String(w).toLowerCase());
    return " ";
  });
  rest = rest.replace(/(?:^|\s)-(?!\s)("[^"]+"|[^\s()]+)/g, (_m, w: string) => {
    const term = String(w).replace(/"/g, "").trim();
    if (term && !/^(?:inurl|site|intitle):/i.test(term)) notTerms.push(term.toLowerCase());
    return " ";
  });
  rest = rest.replace(/\bsite:\s*"?([^\s")]+)"?/gi, (_m, s: string) => {
    sites.push(String(s).toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    return " ";
  });
  rest = rest.replace(OPERATOR, " ");

  const phrases = [...rest.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);

  // What is left is the search itself. Google's grouping punctuation means
  // nothing to a web-search tool, and `OR` between bare words reads as noise,
  // so parentheses go and the quotes stay.
  const text = rest
    .replace(/[()]/g, " ")
    .replace(/\s+OR\s+/g, " OR ")
    .replace(/\s+AND\s+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { text, sites, notInUrl, notTerms, phrases };
}

/**
 * The query as something a web-search tool can act on. The `site:` filters are
 * mentioned in words as well as enforced afterwards: told to look on LinkedIn
 * the model actually goes there, and the check below is then rarely the thing
 * that has to throw results away.
 */
export function toNaturalSearch(p: ParsedQuery): string {
  const bits = [p.text];
  if (p.sites.length) bits.push(`on ${p.sites.join(" or ")}`);
  return bits.filter(Boolean).join(" ").trim();
}

/** Whether a result would have survived the operators Google was never given. */
export function keepHit(hit: SearchHit, p: ParsedQuery): boolean {
  const url = hit.url.toLowerCase();
  if (!/^https?:\/\//.test(url)) return false;
  if (p.sites.length) {
    // `site:linkedin.com/in` is a host and a path prefix; `site:linkedin.com`
    // is a host alone. Both are matched against the address as written, with
    // the country subdomains LinkedIn serves the same profile from (lk., uk.)
    // treated as the bare host — see canonicalProfile in serper.ts.
    const bare = url.replace(/^https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?/, "");
    if (!p.sites.some((s) => bare.startsWith(s.replace(/^(?:[a-z]{2,3}\.)?(?:www\.)?/, "")))) return false;
  }
  if (p.notInUrl.some((w) => url.includes(w))) return false;
  const text = `${hit.title} ${hit.snippet}`.toLowerCase();
  if (p.notTerms.some((w) => text.includes(w))) return false;
  return true;
}

/** A result, with how many of the parallel queries turned it up. */
export interface RankedHit extends SearchHit {
  hitCount: number;
  matchedQueries: string[];
}

/**
 * Several query angles at once, deduplicated by address, ordered by how many
 * angles found the same page (the scraper's cross-query verification).
 *
 * `key` decides what counts as the same page: Benchmark passes
 * canonicalProfile, so one person behind `lk.` and `www.` is one row.
 */
export async function searchMatrix(
  queries: string[],
  search: (q: string, num?: number) => Promise<{ hits: SearchHit[]; credits: number; error?: string }>,
  opts: { num?: number; key?: (url: string) => string | null } = {},
): Promise<{ hits: RankedHit[]; credits: number; ran: number; errors: string[] }> {
  const key = opts.key ?? ((u: string) => u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase());
  const answers = await Promise.all(queries.map((q) => search(q, opts.num ?? 10)));

  const found = new Map<string, RankedHit>();
  let credits = 0;
  const errors: string[] = [];
  answers.forEach((a, i) => {
    credits += a.credits || (a.error ? 0 : 1);
    // Reported rather than swallowed: a caller that stops on the spend cap
    // must still stop when the angle that hit it was one of several.
    if (a.error) errors.push(a.error);
    for (const hit of a.hits) {
      const k = key(hit.url);
      if (!k) continue;
      const had = found.get(k);
      if (!had) {
        found.set(k, { ...hit, hitCount: 1, matchedQueries: [queries[i]] });
        continue;
      }
      had.hitCount++;
      if (!had.matchedQueries.includes(queries[i])) had.matchedQueries.push(queries[i]);
      // Keep the fullest description of the page across the angles that found it.
      if (hit.snippet.length > had.snippet.length) had.snippet = hit.snippet;
      if (!had.title && hit.title) had.title = hit.title;
    }
  });

  const hits = [...found.values()].sort((a, b) => b.hitCount - a.hitCount);
  return { hits, credits, ran: queries.length, errors };
}
