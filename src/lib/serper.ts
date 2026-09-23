/**
 * Google search through Serper — spec §8A.2.
 *
 * This is the *retrieval* half of Suggestions, and it is deliberately separate
 * from the model. Serper finds the profiles; the model only ever filters a list
 * it was handed. That split is not a cost decision: it is what makes a
 * fabricated profile structurally impossible, because no model in the pipeline
 * is ever asked to produce a URL.
 */
import { reserve, serperMaxCost, SpendCapError } from "./spend";
import { keepHit, parseBooleanQuery, toNaturalSearch } from "./websearch";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  credits: number;
  error?: string;
}

/**
 * Who answers a search: "serper" (Google through Serper) or "openai" (OpenAI's
 * web search). C141_SEARCH_PROVIDER picks; unset, Serper when its key is
 * there. Suggestions and Benchmark stopped dead on "no_serper" wherever the
 * Serper key was missing (21 Sep).
 *
 * OpenAI only when chosen by name. Every server has an OpenAI key for other
 * work, so falling back to it turned a missing Serper key into paid web
 * searches nobody had asked for (review of PR #2, 21 Sep).
 */
export function searchProvider(): "serper" | "openai" | "searxng" | null {
  const chosen = (process.env.C141_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const serper = (process.env.SERPER_API_KEY ?? "").trim().length > 0;
  const openai = (process.env.OPENAI_API_KEY ?? "").trim().length > 0;
  if (chosen === "openai") return openai ? "openai" : null;
  if (chosen === "serper") return serper ? "serper" : null;
  if (chosen === "searxng") return "searxng";
  // SearXNG needs no key, so it is preferred once an instance is named: the
  // desk asked to come off Serper (23 Sep). Serper still answers when it is
  // the only thing configured, or when it is named outright.
  if (searxngInstances().length) return "searxng";
  return serper ? "serper" : null;
}

/**
 * The SearXNG instances to ask, in order. SEARXNG_URL takes one or several,
 * comma-separated: public instances rate-limit and go down, so the next one in
 * the list answers when the first refuses. A self-hosted instance is one entry
 * and never needs the rest.
 */
export function searxngInstances(): string[] {
  return (process.env.SEARXNG_URL ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => /^https?:\/\//.test(u));
}

/**
 * Which engines SearXNG asks. Google alone unless SEARXNG_ENGINES says
 * otherwise — measured on the server, 23 September:
 *
 *   google      10 results, nothing failed
 *   duckduckgo  suspended: timeout      brave  suspended: too many requests
 *   qwant       CAPTCHA                 google cse  suspended: too many requests
 *
 * The refusals are what made a search take six seconds: SearXNG waited for
 * engines that were never going to answer, and a query where enough of them
 * failed came back empty and was reported to the desk as a broken search.
 * Google is also the only one of them that honours `site:` and `-inurl:`,
 * which is what Research and Benchmark are written in.
 */
export function searxngEngines(): string {
  return (process.env.SEARXNG_ENGINES ?? "").trim() || "google";
}

/** Whether any search can run. Kept under its old name: callers ask "can we search?". */
export function serperConfigured(): boolean {
  return searchProvider() !== null;
}

export async function search(q: string, num = 10, page = 1): Promise<SearchResult> {
  const provider = searchProvider();
  if (provider === "searxng") return searchSearxng(q, num, page);
  if (provider === "openai") return searchOpenAI(q, num, page);
  const key = (process.env.SERPER_API_KEY ?? "").trim();
  if (!key) return { hits: [], credits: 0, error: "no_key" };
  // The test's hard stop. More than ten results costs two credits.
  let settle: (usd: number) => void;
  try {
    settle = reserve(`search · serper`, serperMaxCost(num > 10 ? 2 : 1));
  } catch (e) {
    if (e instanceof SpendCapError) return { hits: [], credits: 0, error: "spend_cap" };
    throw e;
  }
  // A failed search may still have been charged: unknown counts as the reservation (NaN), a known answer as its credits.
  let used = Number.NaN;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num, ...(page > 1 ? { page } : {}) }),
    });
    if (!res.ok) return { hits: [], credits: 0, error: `${res.status}` };
    const body = (await res.json()) as {
      organic?: { link?: string; title?: string; snippet?: string }[];
      credits?: number;
    };
    used = body.credits ?? 1;
    return {
      hits: (body.organic ?? [])
        .filter((r) => r.link)
        .map((r) => ({ url: r.link!, title: r.title ?? "", snippet: r.snippet ?? "" })),
      credits: used,
    };
  } catch (e) {
    return { hits: [], credits: 0, error: String(e) };
  } finally {
    settle(serperMaxCost(used));
  }
}

/**
 * The same search through OpenAI's web search tool. It answers in prose, so it
 * is asked for one result per line and only addresses it actually cited are
 * kept — a URL the model wrote but did not fetch is dropped, which keeps the
 * rule above: no model in the pipeline produces a profile address.
 *
 * Every caller writes Google Boolean (`site:`, `-inurl:`), which this tool
 * does not understand, so the operators are stripped before the search and
 * applied to the results afterwards — see websearch.ts (23 Sep).
 */
/**
 * What one OpenAI web search may cost: the tool call (about 2.5 cents) and a
 * small model's tokens around it. Reserved against the test cap like a Serper
 * credit, so this path is counted too.
 */
const OPENAI_SEARCH_MAX_USD = 0.04;

async function searchOpenAI(q: string, num: number, page: number): Promise<SearchResult> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  const model = (process.env.C141_MODEL_SEARCH_OPENAI ?? "").trim() || "gpt-4.1-mini";
  let settle: (usd: number) => void;
  try {
    settle = reserve(`search · openai`, OPENAI_SEARCH_MAX_USD);
  } catch (e) {
    if (e instanceof SpendCapError) return { hits: [], credits: 0, error: "spend_cap" };
    throw e;
  }
  // A failed call may still have been charged, so the reservation is recorded as spent.
  const parsed = parseBooleanQuery(q);
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        store: false,
        max_output_tokens: 1500,
        input: `Run this web search and list what it returns${page > 1 ? ` (results ${10 * (page - 1) + 1} onwards)` : ""}, up to ${num} results, one per line, exactly as:
URL | page title | one-sentence snippet from the page
No other text.${parsed.sites.length ? `\nList only pages on ${parsed.sites.join(" or ")}.` : ""}${
          parsed.phrases.length ? `\nEvery page must mention: ${parsed.phrases.join("; ")}.` : ""
        }

Search: ${toNaturalSearch(parsed)}`,
      }),
    });
    if (!res.ok) return { hits: [], credits: 0, error: `${res.status}` };
    const json = (await res.json()) as {
      output?: { content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[] }[];
    };
    const cited = new Map<string, string>();
    let text = "";
    for (const item of json.output ?? []) {
      for (const c of item.content ?? []) {
        if (c.type !== "output_text") continue;
        text += `${c.text ?? ""}\n`;
        for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url) cited.set(clean(a.url), a.title ?? "");
      }
    }
    const hits: SearchHit[] = [];
    for (const line of text.split("\n")) {
      const [u, title, snippet] = line.split("|").map((x) => x?.trim() ?? "");
      const url = clean(u.replace(/^[-*\d.)\s]+/, "").replace(/^\[?([^\]]*)\]?\(?(https?:[^)\s]+)\)?$/, "$2"));
      if (!/^https?:\/\//.test(url) || !cited.has(url)) continue;
      const hit = { url, title: title || cited.get(url) || "", snippet: snippet ?? "" };
      if (!keepHit(hit, parsed)) continue;
      if (!hits.some((h) => h.url === url)) hits.push(hit);
    }
    // Anything cited but not listed still counts as a result.
    for (const [url, title] of cited) {
      const hit = { url, title, snippet: "" };
      if (keepHit(hit, parsed) && !hits.some((h) => h.url === url)) hits.push(hit);
    }
    return { hits: hits.slice(0, num), credits: 1 };
  } catch (e) {
    return { hits: [], credits: 0, error: String(e) };
  } finally {
    settle(Number.NaN);
  }
}

/**
 * SearXNG — 23 September. A metasearch front end: it asks Google, Bing,
 * DuckDuckGo and the rest and hands back their results, with no key and no
 * bill. The desk moved to it after a Serper refusal was reported at the desk
 * as "the search found nothing under the client's name".
 *
 * Two things about a public instance decide whether this works at all, and
 * both come back as a plain error rather than an empty page:
 *  - most instances serve `format=json` only if their settings.yml allows it,
 *    and answer 403 when it does not;
 *  - they rate-limit hard, and Research fires about thirty searches per
 *    opening, so SEARXNG_URL takes several instances and the next one answers
 *    when the one before it refuses.
 * Self-hosting removes both, which is where this is going.
 *
 * `site:` and `-inurl:` are passed through — the engines behind SearXNG are
 * the ones that understand them — and then enforced on our side anyway
 * (websearch.ts), so an instance whose engines ignored an operator returns
 * fewer results, never the wrong ones.
 */
const SEARXNG_TIMEOUT_MS = 12_000;

/**
 * How fast SearXNG may be asked — measured on the server, 23 September.
 *
 * Six searches at once: all six answered, 1.5 seconds. Eighteen at once, which
 * is what Research reaches when it searches six competitors from three angles:
 * three answered and Google sent a CAPTCHA, after which SearXNG suspended it
 * and the remaining fifteen got nothing. A suspended engine is suspended for
 * everybody, so one run firing everything at once takes the desk's search out
 * from under whoever asks next.
 *
 * Google is being scraped from one data-centre address here. It will tolerate a
 * steady trickle and not a burst, so searches queue: two in flight, a breath
 * between each. A run of thirty takes something like twenty seconds instead of
 * two, which is the price of it working at all. Both are tunable without a
 * deploy, because the number that keeps Google happy is not ours to decide.
 */
const SEARXNG_MAX_IN_FLIGHT = Number(process.env.SEARXNG_CONCURRENCY ?? "") || 2;
const SEARXNG_MIN_GAP_MS = Number(process.env.SEARXNG_MIN_GAP_MS ?? "") || 700;

let inFlight = 0;
let lastStartedAt = 0;
const waiting: (() => void)[] = [];

/** Run `fn` when there is room, and never sooner than a gap after the last one. */
export async function searxngSlot<T>(fn: () => Promise<T>, max = SEARXNG_MAX_IN_FLIGHT, gapMs = SEARXNG_MIN_GAP_MS): Promise<T> {
  await new Promise<void>((resolve) => {
    const take = () => {
      if (inFlight < max) {
        inFlight++;
        resolve();
      } else {
        waiting.push(take);
      }
    };
    take();
  });
  try {
    // The slot is taken before anything is awaited. Reading the clock and then
    // waiting let two callers both decide they were first, and fire together —
    // which is the burst this exists to prevent.
    const now = Date.now();
    const startAt = Math.max(now, lastStartedAt + gapMs);
    lastStartedAt = startAt;
    if (startAt > now) await new Promise((r) => setTimeout(r, startAt - now));
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

interface SearxngBody {
  results?: { url?: string; title?: string; content?: string }[];
  /** `[["brave", "too many requests"], ["duckduckgo", "timeout"]]`. */
  unresponsive_engines?: unknown[];
}

/** The engines that did not answer, as "brave: too many requests". */
export function searxngRefusals(unresponsive: unknown[] | undefined): string {
  return (unresponsive ?? [])
    .map((e) => (Array.isArray(e) ? e.filter((x) => typeof x === "string").join(": ") : String(e)))
    .filter(Boolean)
    .join(", ");
}

/** What one instance answered, as hits. Pure, so the mapping is testable. */
export function searxngHits(body: SearxngBody, q: string, num: number): SearchHit[] {
  const parsed = parseBooleanQuery(q);
  const out: SearchHit[] = [];
  for (const r of body.results ?? []) {
    const url = (r.url ?? "").trim();
    if (!/^https?:\/\//.test(url)) continue;
    const hit = { url, title: (r.title ?? "").trim(), snippet: (r.content ?? "").trim() };
    if (!keepHit(hit, parsed)) continue;
    if (out.some((h) => h.url === hit.url)) continue;
    out.push(hit);
  }
  return out.slice(0, num);
}

function searchSearxng(q: string, num: number, page: number): Promise<SearchResult> {
  return searxngSlot(() => askSearxng(q, num, page));
}

async function askSearxng(q: string, num: number, page: number): Promise<SearchResult> {
  const instances = searxngInstances();
  if (!instances.length) return { hits: [], credits: 0, error: "no_searxng_url" };
  const engines = searxngEngines();
  let lastError = "";
  for (const base of instances) {
    const params = new URLSearchParams({
      q,
      format: "json",
      language: "en",
      safesearch: "0",
      ...(page > 1 ? { pageno: String(page) } : {}),
      ...(engines ? { engines } : {}),
    });
    try {
      const res = await fetch(`${base}/search?${params}`, {
        headers: {
          accept: "application/json",
          // An instance that sees no browser at all answers 403 on sight.
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
      });
      // 403: JSON is off on this instance. 429: we are being rate-limited.
      // Either way the next instance in the list gets the same question.
      if (!res.ok) {
        lastError = `${hostOf(base)} ${res.status}`;
        continue;
      }
      // A public instance with JSON switched off answers 200 and an HTML page
      // — its bot check, or the search page itself. Probed 23 Sep: every
      // public instance tried did one of these. Say which, rather than let
      // JSON.parse throw somewhere unhelpful.
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        lastError = `${hostOf(base)} served HTML, not JSON (bot check, or JSON is off on that instance)`;
        continue;
      }
      const body = (await res.json()) as SearxngBody;
      const hits = searxngHits(body, q, num);
      // No results *and* engines that did not answer is a broken search, not
      // an empty one — the whole point of the 23 Sep fix upstream.
      if (!hits.length && (body.unresponsive_engines ?? []).length) {
        // Which engine, and what it said: "engines unavailable" on its own sent
        // the desk hunting through logs for something the answer already held.
        lastError = `${hostOf(base)} — ${searxngRefusals(body.unresponsive_engines)}`;
        continue;
      }
      // A search happened and cost nothing; it is still counted as one search.
      return { hits, credits: 1 };
    } catch (e) {
      lastError = `${hostOf(base)} ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : String(e)}`;
    }
  }
  return { hits: [], credits: 0, error: lastError || "searxng_unreachable" };
}

/** An instance's host, for an error a person can act on. */
function hostOf(base: string): string {
  try {
    return new URL(base).hostname;
  } catch {
    return base;
  }
}

/** An address without OpenAI's tracking suffix. */
function clean(url: string): string {
  return url.replace(/[?&]utm_source=openai$/, "").replace(/\?$/, "");
}

/**
 * LinkedIn blocks us (HTTP 999), but the pages enrichment turns up alongside it
 * — ZoomInfo, RocketReach, company team pages, news — do not. Reading one of
 * those is the cheapest way past the snippet ceiling: it is a fetch, not a
 * search, so it costs no credits at all.
 */
export async function readPage(url: string, maxChars = 1200): Promise<string | null> {
  if (/linkedin\.com/i.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 80 ? text.slice(0, maxChars) : null;
  } catch {
    // A page that will not load is simply one less source, never an error.
    return null;
  }
}

/**
 * One person, one key. LinkedIn serves the same profile from several country
 * subdomains — Sahan Gunarathna resolves at both `lk.` and `www.` — so a naive
 * dedupe on the raw URL counts him twice and a `lk.`-only search misses him
 * entirely.
 */
export function canonicalProfile(url: string): string | null {
  // The scheme is optional: rows pasted by hand were saved without one, and
  // then never counted as already known (21 Sep).
  const m = url.trim().match(/^(?:https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  return `linkedin.com/in/${decodeURIComponent(m[2]).toLowerCase()}`;
}

export function displayUrl(canonical: string): string {
  return `https://www.${canonical}`;
}
