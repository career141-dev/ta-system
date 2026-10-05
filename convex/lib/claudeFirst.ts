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

export async function askClaudeFirst(
  task: ClaudeFirstTask,
  system: string,
  prompt: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
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
