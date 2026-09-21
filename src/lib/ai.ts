/**
 * The only file in the app that talks to a model — spec §8A.
 *
 * Everything above it asks for *content*, never for an API call, which is what
 * makes the provider swappable and the no-key path honest. Three rules hold
 * everywhere downstream:
 *
 *   1. **No key is a supported state, not an error.** Every caller gets a
 *      structured `unavailable` result and falls back to the deterministic
 *      output that already exists. The app never breaks because a key is absent.
 *   2. **Claims about the world carry sources.** `research` and `benchmark` ask
 *      about real companies and real people; a model with no web access will
 *      invent both confidently. Those calls go through `searchWeb`, and a line
 *      with no citation is dropped before it reaches the screen.
 *   3. **Nothing is presented as fact that the system did not fetch.** Where a
 *      thing could not be verified, the page says so.
 */

import { capActive, maxModelCost, modelCost, reserve, SpendCapError } from "./spend";

export type AiFailure =
  | "no_key"
  | "rate_limited"
  | "refused"
  | "bad_response"
  | "network"
  | "search_disabled"
  | "spend_cap";

export interface Source {
  url: string;
  title: string;
  /** Up to ~150 characters of the sentence the claim came from. */
  quote: string;
}

export type AiResult =
  | { ok: true; text: string; sources: Source[]; searches: number; provider: string; usage?: Usage }
  | { ok: false; reason: AiFailure; detail?: string };

// ─── Configuration ───────────────────────────────────────────────────────────

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";

function anthropicKey() {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim();
}
function openaiKey() {
  return (process.env.OPENAI_API_KEY ?? "").trim();
}
function googleKey() {
  return (process.env.GOOGLE_API_KEY ?? "").trim();
}
function openrouterKey() {
  return (process.env.OPENROUTER_API_KEY ?? "").trim();
}

/**
 * Model per task, because the four jobs are not the same work — spec §8B.
 * Writing wants the best writer; filtering snippets wants something cheap and
 * fast. Each is overridable from .env.local so a disappointing result is a
 * one-line change rather than a rebuild.
 */
export type Task = "jd" | "research" | "rank" | "extract" | "plan" | "parse" | "assist";

/**
 * One key, several models. OpenRouter's ids are `vendor/model`; the direct APIs
 * take the bare name. Both are kept because the choice of route is the user's,
 * and the only thing that differs is who bills the search.
 */
const OPENROUTER_MODEL: Record<Task, string> = {
  // DeepSeek V4 Flash, the model the matching engine already uses (16 September,
  // at the desk's request). Checked the same day to serve through the
  // zero-retention providers this route insists on.
  jd: "deepseek/deepseek-v4-flash",
  extract: "anthropic/claude-sonnet-5",
  // Was google/gemini-3.1-pro-preview, which this account's OpenRouter
  // guardrails do not serve — the same 404 that took the other Gemini models
  // off (see rank below). Research and Benchmark then read "The model
  // returned something unusable" (testing, 21 Sep). DeepSeek V4 Flash is
  // served; it has no search of its own, so the web plugin uses Exa for it
  // (webEngine below). Override with C141_MODEL_RESEARCH.
  research: "deepseek/deepseek-v4-flash",
  // rank, plan and parse read text into a fixed structure. They were Gemini
  // 3.6 Flash and 2.5 Flash Lite, which this account's OpenRouter guardrails do
  // not serve (404, checked 16 September) — Reports' sentence box, reading the
  // Director's and client's replies, and headhunting plans all failed with "The
  // model returned something unusable". DeepSeek V4 Flash is served. Each is
  // still overridable (C141_MODEL_RANK, C141_MODEL_PARSE).
  rank: "deepseek/deepseek-v4-flash",
  plan: "deepseek/deepseek-v4-flash",
  parse: "deepseek/deepseek-v4-flash",
  // The desk assistant: someone is waiting for the answer. It was
  // openai/gpt-4o-mini, which this account's OpenRouter guardrails do not
  // serve: every request came back 404 ("0 endpoints … matching your guardrail
  // restrictions and data policy") and the Copilot said "The model returned
  // something unusable". Checked 16 September: of gpt-4o-mini, gpt-4.1-nano,
  // gpt-5-nano, Gemini 2.5 Flash Lite and 3.6 Flash, Mistral Small, Qwen3 30B
  // and Llama 3.3 70B, only DeepSeek V4 Flash is served — zero-retention, about
  // 0.6–0.8 s to first answer and a fraction of a cent a question. Change it
  // with C141_MODEL_ASSIST once another model is allowed on the account.
  assist: "deepseek/deepseek-v4-flash",
};

const DIRECT_MODEL: Record<Task, string> = {
  jd: "claude-opus-5",
  extract: "claude-sonnet-5",
  research: "gemini-3.1-pro-preview",
  rank: "gemini-3.6-flash",
  plan: "gemini-3.6-flash",
  parse: "gemini-2.5-flash-lite",
  assist: "gpt-4o-mini",
};

const TASK_ENV: Record<Task, string> = {
  jd: "C141_MODEL_JD",
  research: "C141_MODEL_RESEARCH",
  rank: "C141_MODEL_RANK",
  extract: "C141_MODEL_EXTRACT",
  plan: "C141_MODEL_RANK",
  parse: "C141_MODEL_PARSE",
  assist: "C141_MODEL_ASSIST",
};

/**
 * Tasks that turn text into a fixed shape. DeepSeek reasons before it answers,
 * and on these it could spend the whole token allowance thinking and return
 * nothing — the Copilot's 17 Sep failure, and Suggestions' plan step's on
 * 21 Sep ("The model returned something unusable"). They need no reasoning.
 */
const NO_REASONING: ReadonlySet<Task> = new Set<Task>(["assist", "plan", "rank", "parse", "research"]);

/** Whose search the web plugin uses: the model's own where it has one, else Exa. */
export function webEngine(model: string): "native" | "exa" {
  return /^(openai|anthropic|google|x-ai|perplexity)\//.test(model) ? "native" : "exa";
}

/**
 * Every failure, said in the server log with what the provider answered.
 * The pages show one sentence; without this, "unusable" had no cause anyone
 * could see (21 Sep).
 */
export function logAiFailure(task: string, model: string, r: { reason: AiFailure; detail?: string }): void {
  console.warn(`[ai ${task} · ${model}] ${r.reason}${r.detail ? `: ${String(r.detail).slice(0, 400)}` : ""}`);
}

export function viaOpenRouter(): boolean {
  return openrouterKey().length > 0;
}

export function modelFor(task: Task): string {
  const override = (process.env[TASK_ENV[task]] ?? "").trim();
  if (override) return override;
  return viaOpenRouter() ? OPENROUTER_MODEL[task] : DIRECT_MODEL[task];
}

/** Gemini reports thinking tokens separately and bills them as output. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

/**
 * Gemini. Used for everything that is filtering or grounded retrieval: its
 * search grounding does not bill retrieved pages as input tokens, which for
 * search-heavy work is worth more than any per-token price.
 */
/**
 * OpenRouter — an OpenAI-shaped endpoint in front of every vendor.
 *
 * `plugins: [{ id: "web", engine: "native" }]` asks it to use the *provider's own*
 * grounding rather than its Exa fallback. That matters for cost as much as
 * quality: Google does not bill the pages it retrieves, where Exa's results
 * arrive as input tokens you pay for. The same rule that made Gemini cheaper
 * than Anthropic's web search still decides it here.
 */
async function callOpenRouter(
  task: Task,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number; search?: boolean } = {},
): Promise<AiResult & { usage?: Usage }> {
  const key = openrouterKey();
  if (!key) return { ok: false, reason: "no_key" };
  const model = modelFor(task);
  // The test's hard stop: reserve the most this call could cost, or do not make it.
  let settle: (usd: number) => void;
  try {
    settle = reserve(`${task} · ${model}`, maxModelCost(model, prompt.length, opts.maxTokens ?? 8000, opts.search));
  } catch (e) {
    if (e instanceof SpendCapError) return { ok: false, reason: "spend_cap", detail: e.message };
    throw e;
  }
  // A failed request's charge is unknown, not zero: it keeps its full reservation (NaN settles at the maximum).
  let cost = Number.NaN;
  try {
    let r = await openRouterRequest(key, model, task, prompt, opts);
    // An empty answer is nearly always a model that thought until it ran out
    // of room. Once more, without the thinking, before calling it a failure.
    if (!r.ok && r.reason === "bad_response" && r.detail === "empty") {
      logAiFailure(task, model, r);
      r = await openRouterRequest(key, model, task, prompt, { ...opts, noReasoning: true });
    }
    if (!r.ok) logAiFailure(task, model, r);
    if (r.ok) cost = r.cost ?? modelCost(model, r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0);
    const { cost: _c, ...rest } = r as typeof r & { cost?: number };
    return rest;
  } finally {
    settle(cost);
  }
}

async function openRouterRequest(
  key: string,
  model: string,
  task: Task,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number; search?: boolean; noReasoning?: boolean },
): Promise<(AiResult & { usage?: Usage; cost?: number })> {

  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 8000,
          temperature: opts.temperature ?? 0.2,
          messages: [{ role: "user", content: prompt }],
          // Ask for the real charge, so the spending ledger records it rather than an estimate.
          usage: { include: true },
          ...(opts.search ? { plugins: [{ id: "web", engine: webEngine(model) }] } : {}),
          // Only providers that keep nothing and train on nothing — set on every
          // request, not left to the account settings (13 September: with the
          // account switches on, requests still went to first-party endpoints).
          // Someone is watching a spinner on "assist": the fastest such provider.
          provider: { zdr: true, data_collection: "deny", ...(task === "assist" ? { sort: "latency" } : {}) },
          // The Copilot's answers are short and read from the snapshot; they
          // need no thinking. With a whole desk in the prompt, DeepSeek spent
          // up to 540 of its 600 tokens reasoning and sometimes returned
          // nothing — "The model returned something unusable" (17 September).
          // Off, it answers in 3–5 seconds instead of 13–33.
          ...(NO_REASONING.has(task) || opts.noReasoning ? { reasoning: { enabled: false } } : {}),
        }),
      });
    } catch (e) {
      return { ok: false, reason: "network", detail: String(e) };
    }

    if (res.status === 429) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
        continue;
      }
      return { ok: false, reason: "rate_limited" };
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      continue;
    }
    if (!res.ok) {
      return { ok: false, reason: "bad_response", detail: `${res.status} ${(await res.text()).slice(0, 300)}` };
    }

    const json = (await res.json()) as {
      choices?: {
        message?: {
          content?: string;
          annotations?: { type?: string; url_citation?: { url?: string; title?: string; content?: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const msg = json.choices?.[0]?.message;
    const text = msg?.content ?? "";
    if (!text.trim()) return { ok: false, reason: "bad_response", detail: "empty" };

    const sources: Source[] = [];
    for (const a of msg?.annotations ?? []) {
      const c = a.url_citation;
      if (a.type === "url_citation" && c?.url) {
        sources.push({ url: c.url, title: c.title ?? c.url, quote: (c.content ?? "").slice(0, 200) });
      }
    }
    const seen = new Set<string>();
    return {
      ok: true,
      text,
      sources: sources.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))),
      searches: sources.length,
      provider: model,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        thinkingTokens: 0,
      },
      cost: typeof json.usage?.cost === "number" ? json.usage.cost : undefined,
    };
  }
  return { ok: false, reason: "network", detail: "gave up after retries" };
}

export async function gemini(
  task: Task,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<AiResult & { usage?: Usage }> {
  if (viaOpenRouter()) return callOpenRouter(task, prompt, opts);
  if (capActive()) return { ok: false, reason: "spend_cap", detail: "The capped test only spends through OpenRouter, where every call is metered." };
  const key = googleKey();
  if (!key) return { ok: false, reason: "no_key" };
  const model = modelFor(task);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens ?? 8000,
    },
  };

  // 503s from this endpoint are common and transient; a bounded backoff turns a
  // failed generation into a slower one.
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
    } catch (e) {
      return { ok: false, reason: "network", detail: String(e) };
    }
    if (res.status === 429) {
      const detail = await res.text().catch(() => "");
      // limit: 0 means the model is not served on this tier at all. Waiting
      // cannot fix that, so it fails immediately with the reason.
      if (/limit:\s*0\b/.test(detail)) {
        return { ok: false, reason: "rate_limited", detail: `${model} needs billing enabled on the Google key` };
      }
      // Otherwise it is a per-minute ceiling, and the response says how long to
      // wait. Honouring that turns a failed run into a slower one — which
      // matters most on the free tier, where 20/min is reached by two openings.
      const m = detail.match(/retry in ([\d.]+)s/i);
      const waitMs = Math.min((m ? Number(m[1]) : 30) * 1000 + 1500, 70_000);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return { ok: false, reason: "rate_limited", detail: "still limited after waiting" };
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      continue;
    }
    if (!res.ok) {
      return { ok: false, reason: "bad_response", detail: `${res.status} ${(await res.text()).slice(0, 240)}` };
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text.trim()) return { ok: false, reason: "bad_response", detail: "empty" };
    const u = json.usageMetadata ?? {};
    return {
      ok: true,
      text,
      sources: [],
      searches: 0,
      provider: model,
      usage: {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        thinkingTokens: u.thoughtsTokenCount ?? 0,
      },
    };
  }
  return { ok: false, reason: "network", detail: "gave up after retries" };
}

export function aiStatus(): {
  configured: boolean;
  provider: "anthropic" | "openai" | null;
  google: boolean;
  webSearch: boolean;
  model: string;
} {
  const provider = anthropicKey() ? "anthropic" : openaiKey() ? "openai" : null;
  return {
    configured: provider !== null || googleKey().length > 0 || viaOpenRouter(),
    provider,
    google: googleKey().length > 0 || viaOpenRouter(),
    // Only Anthropic's server-side web search is wired up. OpenAI without it
    // would have to answer company questions from memory, which is the exact
    // failure this feature cannot have.
    // Through OpenRouter, grounding rides on the request itself — there is no
    // separate switch to forget to turn on.
    webSearch: viaOpenRouter() || (provider === "anthropic" && (process.env.C141_WEB_SEARCH ?? "off").toLowerCase() === "on"),
    model: (process.env.C141_MODEL ?? "").trim() || DEFAULT_MODEL,
  };
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

interface Block {
  type: string;
  text?: string;
  citations?: {
    type: string;
    url?: string;
    title?: string;
    cited_text?: string;
  }[];
  content?: unknown;
}

/** Sri Lanka, so "who runs this company" returns the Colombo one. */
const USER_LOCATION = {
  type: "approximate",
  city: "Colombo",
  country: "LK",
  timezone: "Asia/Colombo",
};

async function callAnthropic(opts: {
  system: string;
  prompt: string;
  maxTokens: number;
  search: boolean;
  maxSearches: number;
}): Promise<AiResult> {
  const key = anthropicKey();
  if (!key) return { ok: false, reason: "no_key" };
  const model = aiStatus().model;

  const tools = opts.search
    ? [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: opts.maxSearches,
          user_location: USER_LOCATION,
        },
      ]
    : undefined;

  // The turn can pause mid-search; the documented continuation is to send the
  // assistant message back untouched. Bounded so a loop cannot run away.
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: opts.prompt }];
  let searches = 0;
  const sources: Source[] = [];
  let text = "";

  for (let turn = 0; turn < 4; turn++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages,
          ...(tools ? { tools } : {}),
        }),
      });
    } catch (e) {
      return { ok: false, reason: "network", detail: String(e) };
    }

    if (res.status === 429) return { ok: false, reason: "rate_limited" };
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Web search switched off for the org comes back as a 400, and the fix is
      // a setting rather than anything the TA can do — say which it was.
      if (res.status === 400 && /web search/i.test(detail)) {
        return { ok: false, reason: "search_disabled", detail: detail.slice(0, 300) };
      }
      return { ok: false, reason: "bad_response", detail: `${res.status} ${detail.slice(0, 300)}` };
    }

    const body = (await res.json().catch(() => null)) as {
      content?: Block[];
      stop_reason?: string;
      usage?: { server_tool_use?: { web_search_requests?: number } };
    } | null;
    if (!body?.content) return { ok: false, reason: "bad_response" };

    searches += body.usage?.server_tool_use?.web_search_requests ?? 0;

    for (const b of body.content) {
      if (b.type === "text" && b.text) {
        text += b.text;
        for (const c of b.citations ?? []) {
          if (c.type === "web_search_result_location" && c.url) {
            sources.push({
              url: c.url,
              title: c.title ?? c.url,
              quote: (c.cited_text ?? "").slice(0, 200),
            });
          }
        }
      }
    }

    if (body.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: body.content });
      continue;
    }
    break;
  }

  if (!text.trim()) return { ok: false, reason: "bad_response", detail: "empty" };

  // De-duplicate by URL, keeping the first quote seen for each.
  const seen = new Set<string>();
  const unique = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));

  return { ok: true, text, sources: unique, searches, provider: "anthropic" };
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI(opts: {
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<AiResult> {
  const key = openaiKey();
  if (!key) return { ok: false, reason: "no_key" };
  const model = (process.env.C141_MODEL ?? "").trim() || "gpt-4o";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.prompt },
        ],
      }),
    });
    if (res.status === 429) return { ok: false, reason: "rate_limited" };
    if (!res.ok) {
      return { ok: false, reason: "bad_response", detail: `${res.status} ${(await res.text()).slice(0, 300)}` };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return { ok: false, reason: "bad_response", detail: "empty" };
    return { ok: true, text, sources: [], searches: 0, provider: "openai" };
  } catch (e) {
    return { ok: false, reason: "network", detail: String(e) };
  }
}

/**
 * OpenAI's own web search (the Responses API `web_search` tool): the answer
 * and the pages it cited, which become the sources. The model is
 * C141_MODEL_RESEARCH_OPENAI, gpt-4.1-mini unless set.
 */
async function callOpenAIWebSearch(args: { system: string; prompt: string; maxTokens: number }): Promise<AiResult> {
  const key = openaiKey();
  if (!key) return { ok: false, reason: "no_key", detail: "OPENAI_API_KEY is not set" };
  const model = (process.env.C141_MODEL_RESEARCH_OPENAI ?? "").trim() || "gpt-4.1-mini";
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: args.system,
        input: args.prompt,
        tools: [{ type: "web_search" }],
        max_output_tokens: args.maxTokens,
        store: false,
      }),
    });
  } catch (e) {
    return { ok: false, reason: "network", detail: String(e) };
  }
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "bad_response", detail: `${res.status} ${(await res.text()).slice(0, 300)}` };
  const json = (await res.json()) as {
    output?: {
      type?: string;
      content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
    }[];
  };
  let text = "";
  const sources: Source[] = [];
  let searches = 0;
  for (const item of json.output ?? []) {
    if (item.type === "web_search_call") searches++;
    for (const c of item.content ?? []) {
      if (c.type !== "output_text") continue;
      text += c.text ?? "";
      for (const a of c.annotations ?? []) {
        if (a.type === "url_citation" && a.url && !sources.some((x) => x.url === a.url)) {
          sources.push({ url: a.url, title: a.title ?? a.url, quote: "" });
        }
      }
    }
  }
  if (!text.trim()) return { ok: false, reason: "bad_response", detail: "empty" };
  return { ok: true, text, sources, searches, provider: `openai/${model}` };
}

// ─── What the app actually calls ─────────────────────────────────────────────

/** Writing, from material the caller supplies. No claims about the world. */
export async function write(system: string, prompt: string, maxTokens = 2000, task: Task = "jd"): Promise<AiResult> {
  if (viaOpenRouter()) return callOpenRouter(task, `${system}\n\n${prompt}`, { maxTokens });
  if (capActive()) return { ok: false, reason: "spend_cap", detail: "The capped test only spends through OpenRouter, where every call is metered." };
  if (anthropicKey()) return callAnthropic({ system, prompt, maxTokens, search: false, maxSearches: 0 });
  if (openaiKey()) return callOpenAI({ system, prompt, maxTokens });
  return { ok: false, reason: "no_key" };
}

/**
 * Questions about the world — companies, people, markets. Refuses rather than
 * answering from memory, because an unsourced claim about a client's competitor
 * is worse than no claim at all.
 */
export async function research(system: string, prompt: string, maxTokens = 3000, maxSearches = 8): Promise<AiResult> {
  // C141_RESEARCH_PROVIDER picks who searches the web: "openai" (OpenAI's own
  // web search), "openrouter" or "anthropic". Unset, OpenRouter wins when its
  // key is present, as before.
  const chosen = (process.env.C141_RESEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (chosen === "openai" || (!chosen && !viaOpenRouter() && !anthropicKey() && openaiKey())) {
    if (capActive()) return { ok: false, reason: "spend_cap", detail: "The capped test only spends through OpenRouter, where every call is metered." };
    const r = await callOpenAIWebSearch({ system, prompt, maxTokens });
    if (!r.ok) logAiFailure("research", "openai-web-search", r);
    return r;
  }
  if (chosen !== "anthropic" && viaOpenRouter()) {
    return callOpenRouter("research", `${system}\n\n${prompt}`, { maxTokens, search: true });
  }
  if (capActive()) return { ok: false, reason: "spend_cap", detail: "The capped test only spends through OpenRouter, where every call is metered." };
  const st = aiStatus();
  if (!st.configured) return { ok: false, reason: "no_key" };
  if (!st.webSearch) return { ok: false, reason: "search_disabled" };
  return callAnthropic({ system, prompt, maxTokens, search: true, maxSearches });
}

export const FAILURE_MESSAGE: Record<AiFailure, string> = {
  no_key: "The AI is not set up on this system (no model key). An admin needs to add one.",
  rate_limited: "The model is rate-limited right now. Try again in a minute.",
  refused: "The model declined to answer this one.",
  bad_response: "The AI's answer could not be read. Try again — if it keeps happening, the reason is in the server log.",
  network: "Could not reach the AI service. Check the connection and try again.",
  spend_cap: "The test's $5 spending cap would be passed, so this was not run.",
  search_disabled:
    "Web search is off, so this would have to be answered from memory — which for company facts means inventing them. Set C141_WEB_SEARCH=on in .env.local (Anthropic key required).",
};
