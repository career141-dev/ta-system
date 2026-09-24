import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiResult, Task } from "./ai";
import type { SearchHit, SearchResult } from "./serper";
import { keepHit, parseBooleanQuery } from "./websearch";

/**
 * The owner's Claude subscription, for the desk's research and suggestions
 * (24 Sep, at the owner's request).
 *
 * It runs the Claude Code CLI — `claude -p` — logged in with a long-lived
 * subscription token (`claude setup-token`, set as CLAUDE_CODE_OAUTH_TOKEN), so
 * nothing is billed per call. Anything that goes wrong — the token missing,
 * the usage limit reached, the CLI slow or absent — returns a failure, and the
 * caller carries on exactly as before. The desk never waits on the
 * subscription being available.
 *
 * Two uses:
 *  - thinking: the tasks named in C141_CLAUDE_SUB_TASKS, answered with no
 *    tools at all (askSubscription). Only from SAFE: those prompts carry a
 *    client's name, public web pages and the desk's own notes. Tasks that read
 *    a candidate's CV or messages are refused here whatever the setting says,
 *    so a candidate's details never reach a personal account.
 *  - searching: Claude's own web search, as the first engine behind every
 *    search the desk makes, when C141_CLAUDE_SEARCH=on (claudeWebSearch).
 */
const SAFE: ReadonlySet<Task> = new Set<Task>(["plan", "research", "jd"]);
const TIMEOUT_MS = 120_000;
/** One search is one query and one short answer; longer than this, SearXNG answers instead. */
const SEARCH_TIMEOUT_MS = 60_000;

export function viaSubscription(task: Task): boolean {
  if (!SAFE.has(task)) return false;
  if (!hasToken()) return false;
  const wanted = (process.env.C141_CLAUDE_SUB_TASKS ?? "").split(",").map((t) => t.trim());
  return wanted.includes(task);
}

function hasToken(): boolean {
  return (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim().length > 0;
}

/** Run the CLI once: the prompt on stdin, whatever it printed back. */
async function runClaude(args: string[], prompt: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  // An empty folder to run in, so the CLI has nothing of the app's to read.
  const cwd = await mkdtemp(join(tmpdir(), "c141-claude-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.env.C141_CLAUDE_BIN || "claude", ["-p", "--no-session-persistence", "--strict-mcp-config", ...args], {
        cwd,
        // Only what the CLI needs. Above all no ANTHROPIC_API_KEY: with one
        // present the CLI bills that paid key instead of the subscription.
        // And none of the app's other secrets, which it has no use for.
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? tmpdir(),
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: e.message, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, timedOut });
      });
      child.stdin.end(prompt);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export async function askSubscription(task: Task, prompt: string): Promise<AiResult> {
  // No tools at all: it answers from the prompt, it does not act.
  const r = await runClaude(["--output-format", "text", "--tools", ""], prompt, TIMEOUT_MS);
  const text = r.out.trim();
  if (r.timedOut) return { ok: false, reason: "network", detail: `Claude subscription: no answer in ${TIMEOUT_MS / 1000}s` };
  if (r.code === 0 && text) return { ok: true, text, sources: [], searches: 0, provider: `claude-subscription · ${task}` };
  // Usage limit, expired token, CLI error: said in the log, and the caller falls back.
  return { ok: false, reason: "network", detail: `Claude subscription exited ${r.code}: ${(r.err || text).slice(0, 300)}` };
}

// ─── Claude's own web search ────────────────────────────────────────────────

/**
 * Claude's web search as the first engine behind every search — 24 Sep, at the
 * owner's request: "Claude should handle all search", with SearXNG behind it
 * for when Claude's search fails.
 *
 * The rule the search layer was built on still holds: no model writes an
 * address. Claude runs its WebSearch tool, and the addresses kept are the ones
 * that tool returned — read from the tool's own result in the CLI's event
 * stream, not from Claude's reply. Claude's reply only adds a line about each
 * page (the snippet); an address it wrote that the search did not return is
 * dropped and counted, so the benchmark shows how often that happens.
 */
export function claudeSearchEnabled(): boolean {
  return (process.env.C141_CLAUDE_SEARCH ?? "").trim().toLowerCase() === "on" && hasToken();
}

// ponytail: one pause for the whole process after any failure. Per-reason
// pauses (a usage limit for hours, a timeout for seconds) if the benchmark
// shows this throws away good searches.
const PAUSE_MS = 2 * 60_000;
let pausedUntil = 0;
let pausedFor = "";

/** Why Claude's search is being skipped right now, or null when it may be asked. */
export function claudeSearchPaused(): string | null {
  return Date.now() < pausedUntil ? pausedFor : null;
}

export async function claudeWebSearch(q: string, num = 10): Promise<SearchResult> {
  const model = (process.env.C141_CLAUDE_SEARCH_MODEL ?? "").trim();
  const r = await runClaude(
    [
      "--output-format", "stream-json", "--verbose",
      // The search tool and nothing else: it cannot read the server's files,
      // run a command or open a page of its own.
      "--tools", "WebSearch", "--allowedTools", "WebSearch",
      ...(model ? ["--model", model] : []),
    ],
    searchPrompt(q, num),
    SEARCH_TIMEOUT_MS,
  );
  const result = r.timedOut
    ? { hits: [], credits: 0, error: `claude: no answer in ${SEARCH_TIMEOUT_MS / 1000}s` }
    : r.code !== 0 && !r.out.trim()
      ? { hits: [], credits: 0, error: `claude: exited ${r.code}: ${r.err.trim().slice(0, 200)}` }
      : parseClaudeSearch(r.out, q, num);
  // A failure is usually not the query but the account — a usage limit, a
  // lapsed token — so the next thirty searches of the same Research run would
  // each wait for the same refusal. SearXNG takes them for a while instead.
  if (result.error) {
    pausedUntil = Date.now() + PAUSE_MS;
    pausedFor = result.error;
  }
  return { ...result, provider: "claude" };
}

function searchPrompt(q: string, num: number): string {
  return `Use the WebSearch tool once, with exactly this query and nothing added or changed:

${q}

Then answer with only a JSON array — no other text — of up to ${num} of the results it returned, in the order it returned them:
[{"url": "the result's address, exactly as the search returned it", "snippet": "one or two sentences of what that page says, from the search result"}]
Only addresses the search returned. If it returned nothing, answer [].`;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: unknown };
}

/**
 * What one `claude -p --output-format stream-json` run found. Pure, so the
 * grounding rule is testable without a subscription.
 *
 * Addresses come from the WebSearch tool results in the stream; the final
 * answer only lends each one a snippet. Operators (`site:`, `-inurl:`) are
 * enforced here as for every other engine (websearch.ts).
 */
export function parseClaudeSearch(stream: string, q: string, num: number): SearchResult & { ungrounded: number } {
  const events: StreamEvent[] = [];
  for (const line of stream.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t) as StreamEvent);
    } catch {
      // A line cut short by a kill; the rest still counts.
    }
  }

  const final = events.find((e) => e.type === "result");
  if (final?.is_error || (final?.subtype && final.subtype !== "success")) {
    return { hits: [], credits: 0, error: `claude: ${(final.result ?? final.subtype ?? "error").slice(0, 200)}`, ungrounded: 0 };
  }

  // Every address the search tool itself returned, with its title.
  const found = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message!.content as { type?: string; content?: unknown }[]) {
      if (block?.type !== "tool_result") continue;
      for (const { url, title } of linksIn(textOf(block.content))) if (!found.has(url)) found.set(url, title);
    }
  }
  // A finished run whose search found nothing is an empty search, not a
  // failed one: SearXNG is asked the same query, and Claude is not rested.
  if (!found.size) return final ? { hits: [], credits: 1, ungrounded: 0 } : { hits: [], credits: 0, error: "claude: no answer", ungrounded: 0 };

  const snippets = new Map<string, string>();
  let ungrounded = 0;
  for (const r of jsonArrayIn(final?.result ?? "")) {
    const url = typeof r?.url === "string" ? r.url.trim() : "";
    if (!url) continue;
    if (!found.has(url)) {
      ungrounded++;
      continue;
    }
    if (typeof r.snippet === "string") snippets.set(url, r.snippet.trim());
  }

  const parsed = parseBooleanQuery(q);
  const hits: SearchHit[] = [];
  for (const [url, title] of found) {
    const hit = { url, title, snippet: snippets.get(url) ?? "" };
    if (keepHit(hit, parsed)) hits.push(hit);
  }
  // A search happened and cost nothing billable; it is still counted as one.
  return { hits: hits.slice(0, num), credits: 1, ungrounded };
}

/** A tool result's text, whether it came as a string or as content blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/**
 * The links in a WebSearch result: `Links: [{"title": …, "url": …}, …]` in the
 * CLI's own format, else any `"title"/"url"` pairs, else bare addresses.
 */
function linksIn(text: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  const push = (url: unknown, title: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) out.push({ url: url.trim(), title: typeof title === "string" ? title.trim() : "" });
  };
  for (const arr of text.matchAll(/Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/g)) {
    try {
      for (const l of JSON.parse(arr[1]) as { url?: unknown; title?: unknown }[]) push(l?.url, l?.title);
    } catch {
      // Not JSON after all: the looser readings below still apply.
    }
  }
  if (out.length) return out;
  for (const m of text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"url"\s*:\s*"([^"]+)"/g)) push(m[2], m[1].replace(/\\"/g, '"'));
  if (out.length) return out;
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) push(m[0], "");
  return out;
}

/** The first JSON array in a reply, tolerating a code fence or words around it. */
function jsonArrayIn(text: string): { url?: unknown; snippet?: unknown }[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
