"use node";

/**
 * Claude first, DeepSeek second, for matching — 5 Oct, at the owner's request.
 * Extraction stays on DeepSeek and never comes through here.
 *
 * The Claude subscription runs only in the web app's container, so the
 * backend asks the app (src/app/api/internal/claude) over the private docker
 * network. A null from here means "use DeepSeek" — exactly the code that ran
 * before — and it is returned for anything short of an answer: the settings
 * missing, the app busy or resting after a failure, a timeout, a refusal.
 * Never a throw: a matching call must not fail because Claude did.
 *
 * Settings (Convex env, both optional; unset, matching is DeepSeek only):
 *   C141_APP_INTERNAL_URL      e.g. http://ta-prod-app:3000
 *   C141_CLAUDE_BRIDGE_SECRET  the same value the app holds
 *
 * Callers send no names or contacts: the prompt says what someone has done,
 * not who they are.
 */
export type ClaudeFirstTask = "match_role" | "match_score" | "match_rank";

/**
 * The app's limit on one Claude answer (src/lib/claudeBridge). 6 Oct: CV-vs-job
 * scoring gave up at 60s and search ranking at 45s, well inside this. Claude
 * often takes longer, so those calls fell to DeepSeek while the abandoned run
 * kept its slot, and the calls behind it were turned away as "busy". Only the
 * role level, which waited the full 90s, was reliably Claude's.
 */
export const CLAUDE_ANSWER_MS = 90_000;
/**
 * How long a call waits for a free Claude slot before DeepSeek answers it. Scoring
 * and role level run in the background, so they wait. For search ranking a TA is
 * looking at the screen, so it waits less.
 */
export const CLAUDE_QUEUE_MS: Record<ClaudeFirstTask, number> = {
  match_role: 60_000,
  match_score: 60_000,
  match_rank: 20_000,
};
/** The caller's whole budget: a wait for a slot, one answer, and the trip over the network. */
export function claudeBudgetMs(task: ClaudeFirstTask): number {
  return CLAUDE_QUEUE_MS[task] + CLAUDE_ANSWER_MS + 5_000;
}

/**
 * When this code runs inside the web app (database search runs the engine's own
 * scoring there, src/lib/engineSearch), the app asks Claude directly rather than
 * over HTTP to itself. 6 Oct: C141_APP_INTERNAL_URL is set only in the Convex env,
 * so database search never asked Claude at all.
 */
type InProcessAsk = (task: ClaudeFirstTask, system: string, prompt: string) => Promise<string | null>;
const IN_PROCESS = Symbol.for("c141.claudeFirst.inProcess");
export function answerInProcess(ask: InProcessAsk | null) {
  (globalThis as Record<symbol, unknown>)[IN_PROCESS] = ask ?? undefined;
}

export async function askClaudeFirst(
  task: ClaudeFirstTask,
  system: string,
  prompt: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const local = (globalThis as Record<symbol, unknown>)[IN_PROCESS] as InProcessAsk | undefined;
  if (local) {
    try {
      const text = await local(task, system, prompt);
      return text?.trim() ? text : null;
    } catch (e: any) {
      console.warn(`[claude-first] ${task} → deepseek: ${e?.message || e}`);
      return null;
    }
  }
  const base = (process.env.C141_APP_INTERNAL_URL ?? "").trim().replace(/\/+$/, "");
  const secret = (process.env.C141_CLAUDE_BRIDGE_SECRET ?? "").trim();
  if (!base || secret.length < 16) return null;
  try {
    const res = await fetcher(`${base}/api/internal/claude`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-c141-secret": secret },
      body: JSON.stringify({ task, system, prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; text?: unknown; reason?: unknown } | null;
    if (res.ok && body?.ok && typeof body.text === "string" && body.text.trim()) return body.text;
    console.warn(`[claude-first] ${task} → deepseek: ${res.status} ${String(body?.reason ?? "").slice(0, 200)}`);
    return null;
  } catch (e: any) {
    console.warn(`[claude-first] ${task} → deepseek: ${e?.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000}s` : e?.message || e}`);
    return null;
  }
}

/** A model's JSON answer, tolerating a code fence or words around it; null when there is none. */
export function jsonIn(text: string): any | null {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
