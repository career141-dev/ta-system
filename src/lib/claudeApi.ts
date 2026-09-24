import type { AiResult, Task } from "./ai";
import { CLAUDE_TASKS } from "./claudeSub";

/**
 * Claude through the Anthropic API, billed to the company's own Console key
 * (24 Sep, owner's choice over the subscription).
 *
 * The subscription route (lib/claudeSub) runs one person's Claude login for the
 * whole desk, which Anthropic's terms do not allow for an app serving other
 * users — the account could be closed without notice. An API key is the
 * sanctioned way for a product to call Claude, and the work here is small:
 * Claude only sorts pages our own search already found, it never browses.
 *
 * Off until ANTHROPIC_API_KEY and C141_CLAUDE_API_TASKS are both set. The same
 * tasks as the subscription may go this way, and no others: anything that
 * reads a candidate's CV or messages is refused whatever the setting says.
 * Whatever Claude cannot answer — a rate limit, a refusal, no answer in time —
 * returns a failure and the caller carries on with OpenRouter as before.
 */
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-5";
const TIMEOUT_MS = 90_000;
// Thinking is on by default on this model and counts against max_tokens; the
// callers' 600–3500 is sized for the answer alone, and a cut-off answer is a
// wasted call. The answer itself stays short because the prompts ask for it.
const MIN_TOKENS = 16_000;

export function claudeApiModel(): string {
  return (process.env.C141_CLAUDE_API_MODEL ?? "").trim() || DEFAULT_MODEL;
}

export function viaClaudeApi(task: Task): boolean {
  if (!CLAUDE_TASKS.has(task)) return false;
  if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) return false;
  const wanted = (process.env.C141_CLAUDE_API_TASKS ?? "").split(",").map((t) => t.trim());
  return wanted.includes(task);
}

export async function askClaudeApi(task: Task, prompt: string, maxTokens = 0): Promise<AiResult> {
  const model = claudeApiModel();
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": (process.env.ANTHROPIC_API_KEY ?? "").trim(),
        "anthropic-version": API_VERSION,
        // A request the model declines is re-run on the model Anthropic picks
        // for that case, inside the same call, rather than coming back empty.
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(maxTokens, MIN_TOKENS),
        messages: [{ role: "user", content: prompt }],
        // Sorting given pages into fields: careful, not deep.
        output_config: { effort: "medium" },
        fallbacks: "default",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return { ok: false, reason: "network", detail: timedOut ? `Claude API: no answer in ${TIMEOUT_MS / 1000}s` : `Claude API: ${String(e)}` };
  }

  if (res.status === 429) return { ok: false, reason: "rate_limited", detail: "Claude API: rate limited" };
  if (!res.ok) {
    return { ok: false, reason: "bad_response", detail: `Claude API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` };
  }
  const body = (await res.json().catch(() => null)) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    model?: string;
  } | null;
  if (!body?.content) return { ok: false, reason: "bad_response", detail: "Claude API: no content" };
  if (body.stop_reason === "refusal") return { ok: false, reason: "refused", detail: "Claude API: declined" };
  // Cut off mid-answer: the JSON would not parse, so it is a failure, not a result.
  if (body.stop_reason === "max_tokens") return { ok: false, reason: "bad_response", detail: "Claude API: ran out of tokens" };

  const text = body.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) return { ok: false, reason: "bad_response", detail: "empty" };
  return { ok: true, text, sources: [], searches: 0, provider: `anthropic/${body.model ?? model} · ${task}` };
}
