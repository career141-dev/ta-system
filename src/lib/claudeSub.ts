import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiResult, Task } from "./ai";

/**
 * The owner's Claude subscription, for the desk's research and suggestions
 * (24 Sep, at the owner's request).
 *
 * It runs the Claude Code CLI — `claude -p` — logged in with a long-lived
 * subscription token (`claude setup-token`, set as CLAUDE_CODE_OAUTH_TOKEN), so
 * nothing is billed per call. Anything that goes wrong — the token missing,
 * the usage limit reached, the CLI slow or absent — returns a failure, and the
 * caller carries on with OpenRouter exactly as before. The desk never waits on
 * the subscription being available.
 *
 * Only the tasks named in C141_CLAUDE_SUB_TASKS go this way, and only from
 * SAFE: those prompts carry a client's name, public web pages and the desk's
 * own notes. Tasks that read a candidate's CV or messages are refused here
 * whatever the setting says, so a candidate's details never reach a personal
 * account.
 */
// Shared with lib/claudeApi: the same tasks, and only these, may go to Claude.
export const CLAUDE_TASKS: ReadonlySet<Task> = new Set<Task>(["plan", "research", "jd"]);
const TIMEOUT_MS = 120_000;

export function viaSubscription(task: Task): boolean {
  if (!CLAUDE_TASKS.has(task)) return false;
  if (!(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) return false;
  const wanted = (process.env.C141_CLAUDE_SUB_TASKS ?? "").split(",").map((t) => t.trim());
  return wanted.includes(task);
}

export async function askSubscription(task: Task, prompt: string): Promise<AiResult> {
  // An empty folder to run in, so the CLI has nothing of the app's to read.
  const cwd = await mkdtemp(join(tmpdir(), "c141-claude-"));
  try {
    return await new Promise<AiResult>((resolve) => {
      const child = spawn(
        process.env.C141_CLAUDE_BIN || "claude",
        // No tools at all: it answers from the prompt, it does not act.
        ["-p", "--output-format", "text", "--tools", "", "--no-session-persistence", "--strict-mcp-config"],
        {
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
        },
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, reason: "network", detail: `Claude subscription: no answer in ${TIMEOUT_MS / 1000}s` });
      }, TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: "network", detail: `Claude subscription: ${e.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = out.trim();
        if (code === 0 && text) {
          resolve({ ok: true, text, sources: [], searches: 0, provider: `claude-subscription · ${task}` });
        } else {
          // Usage limit, expired token, CLI error: said in the log, and the
          // caller falls back.
          resolve({ ok: false, reason: "network", detail: `Claude subscription exited ${code}: ${(err || text).slice(0, 300)}` });
        }
      });
      child.stdin.end(prompt);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
