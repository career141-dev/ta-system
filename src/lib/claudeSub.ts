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
const SAFE: ReadonlySet<Task> = new Set<Task>(["plan", "research", "jd"]);

// One Research run asks up to three questions at once, and each is a CLI
// process of a few hundred MB on a server shared with the database. More than
// this at a time wait for a turn; a turn not come in QUEUE_WAIT_MS goes to
// OpenRouter instead, so a busy morning is slower, not stuck (24 Sep).
const DEFAULT_AT_ONCE = 2;
const QUEUE_WAIT_MS = 20_000;
// Was 120 s: every call that the subscription could not answer held the TA
// that long before OpenRouter was asked (24 Sep).
const DEFAULT_TIMEOUT_MS = 90_000;
// A usage limit or a lapsed login is not fixed by asking again a second later.
// Without a pause, every call in the meantime waited on a CLI that could only
// say no, then went to OpenRouter anyway (24 Sep).
const PAUSE_MS = 15 * 60_000;

let running = 0;
const waiting: (() => void)[] = [];
let pausedUntil = 0;

function atOnce(): number {
  const n = Number(process.env.C141_CLAUDE_SUB_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_AT_ONCE;
}

function timeoutMs(): number {
  const n = Number(process.env.C141_CLAUDE_SUB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function viaSubscription(task: Task, now = Date.now()): boolean {
  if (!SAFE.has(task)) return false;
  if (!(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) return false;
  if (now < pausedUntil) return false;
  const wanted = (process.env.C141_CLAUDE_SUB_TASKS ?? "").split(",").map((t) => t.trim());
  return wanted.includes(task);
}

/**
 * Why the subscription should rest for a while, read from what the CLI said —
 * or null for a failure that the next call might not have.
 */
export function pauseReason(said: string): "usage limit" | "login" | null {
  if (/usage limit|hit your limit|limit reached|limit will reset|resets? at/i.test(said)) return "usage limit";
  if (/invalid api key|oauth token|token (has )?expired|unauthori[sz]ed|\/login|not logged in|authentication/i.test(said)) return "login";
  return null;
}

/** Rest the subscription; calls go straight to OpenRouter until it is over. */
export function pauseSubscription(why: string, now = Date.now()): void {
  pausedUntil = now + PAUSE_MS;
  console.warn(`[claude-subscription] paused for ${PAUSE_MS / 60_000} min: ${why}. Research goes to OpenRouter until then.`);
}

/** For the tests: as the server starts. */
export function resetSubscriptionState(): void {
  running = 0;
  waiting.length = 0;
  pausedUntil = 0;
}

/**
 * A turn to run the CLI: its release function, or null when none came within
 * `waitMs`. Released exactly once, however often it is called.
 */
export function takeTurn(waitMs = QUEUE_WAIT_MS): Promise<(() => void) | null> {
  const turn = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      running--;
      waiting.shift()?.();
    };
  };
  if (running < atOnce()) {
    running++;
    return Promise.resolve(turn());
  }
  return new Promise((resolve) => {
    const next = () => {
      clearTimeout(timer);
      running++;
      resolve(turn());
    };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(next);
      if (i >= 0) waiting.splice(i, 1);
      resolve(null);
    }, waitMs);
    waiting.push(next);
  });
}

export async function askSubscription(task: Task, prompt: string): Promise<AiResult> {
  const release = await takeTurn();
  if (!release) return { ok: false, reason: "rate_limited", detail: `Claude subscription: ${atOnce()} already running, no turn in ${QUEUE_WAIT_MS / 1000}s` };
  // An empty folder to run in, so the CLI has nothing of the app's to read.
  const cwd = await mkdtemp(join(tmpdir(), "c141-claude-")).catch(() => null);
  if (!cwd) {
    release();
    return { ok: false, reason: "network", detail: "Claude subscription: could not make a folder to run in" };
  }
  const limit = timeoutMs();
  // Which Claude answers: the plan's default unless set ("sonnet" is quicker
  // and uses less of the plan's allowance).
  const model = (process.env.C141_CLAUDE_SUB_MODEL ?? "").trim();
  try {
    const r = await new Promise<AiResult>((resolve) => {
      const child = spawn(
        process.env.C141_CLAUDE_BIN || "claude",
        // No tools at all: it answers from the prompt, it does not act.
        [
          "-p",
          "--output-format",
          "text",
          "--tools",
          "",
          "--no-session-persistence",
          "--strict-mcp-config",
          ...(model ? ["--model", model] : []),
        ],
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
        resolve({ ok: false, reason: "network", detail: `Claude subscription: no answer in ${limit / 1000}s` });
      }, limit);
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
          return;
        }
        // Usage limit, expired token, CLI error: said in the log, and the
        // caller falls back. The first two rest the subscription for a while.
        const said = `${err} ${text}`;
        const why = pauseReason(said);
        if (why) pauseSubscription(why);
        resolve({
          ok: false,
          reason: why === "usage limit" ? "rate_limited" : "network",
          detail: `Claude subscription exited ${code}: ${(err || text).slice(0, 300)}`,
        });
      });
      child.stdin.on("error", () => {}); // a CLI that died before reading its prompt
      child.stdin.end(prompt);
    });
    return r;
  } finally {
    release();
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
