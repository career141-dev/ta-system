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
 * there, else OpenAI when that key is. Suggestions and Benchmark stopped dead
 * on "no_serper" wherever the Serper key was missing (21 Sep).
 */
export function searchProvider(): "serper" | "openai" | null {
  const chosen = (process.env.C141_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const serper = (process.env.SERPER_API_KEY ?? "").trim().length > 0;
  const openai = (process.env.OPENAI_API_KEY ?? "").trim().length > 0;
  if (chosen === "openai") return openai ? "openai" : null;
  if (chosen === "serper") return serper ? "serper" : null;
  return serper ? "serper" : openai ? "openai" : null;
}

/** Whether any search can run. Kept under its old name: callers ask "can we search?". */
export function serperConfigured(): boolean {
  return searchProvider() !== null;
}

export async function search(q: string, num = 10, page = 1): Promise<SearchResult> {
  if (searchProvider() === "openai") return searchOpenAI(q, num, page);
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
 */
async function searchOpenAI(q: string, num: number, page: number): Promise<SearchResult> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  const model = (process.env.C141_MODEL_SEARCH_OPENAI ?? "").trim() || "gpt-4.1-mini";
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
No other text.

Search: ${q}`,
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
      if (!hits.some((h) => h.url === url)) hits.push({ url, title: title || cited.get(url) || "", snippet: snippet ?? "" });
    }
    // Anything cited but not listed still counts as a result.
    for (const [url, title] of cited) if (!hits.some((h) => h.url === url)) hits.push({ url, title, snippet: "" });
    return { hits: hits.slice(0, num), credits: 1 };
  } catch (e) {
    return { hits: [], credits: 0, error: String(e) };
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
