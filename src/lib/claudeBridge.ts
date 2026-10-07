import { createHash, timingSafeEqual } from "node:crypto";
import { logSubscriptionUsage, readStream, runClaude } from "./claudeSub";
import { claudeMatchOn } from "./claudeMatch";
import { CLAUDE_ANSWER_MS, CLAUDE_QUEUE_MS } from "../../convex/lib/claudeFirst";

/**
 * Claude first for the backend's matching calls — 5 Oct, at the owner's
 * request: "matching's primary is Claude; if something happens to the Claude
 * subscription, straight away move to DeepSeek." Extraction stays on DeepSeek.
 *
 * The subscription CLI lives in this container only; the backend cannot run
 * it. So the backend asks here (POST /api/internal/claude, over the private
 * docker network), and anything short of an answer — switched off, resting
 * after a failure, slow, refused — is a 503 that sends the backend to
 * DeepSeek at once. When every slot is taken a call waits its turn for a
 * while (CLAUDE_QUEUE_MS) before going to DeepSeek. 6 Oct: refusing at once
 * meant most CV scorings, which arrive in bursts, never reached Claude.
 *
 * Only the matching tasks below come through, and the backend sends them
 * without names or contacts (convex/lib/claudeFirst).
 */
export const BRIDGE_TASKS = ["match_role", "match_score", "match_rank", "match_read"] as const;
export type BridgeTask = (typeof BRIDGE_TASKS)[number];

const TIMEOUT_MS = CLAUDE_ANSWER_MS;
const MAX_PROMPT = 60_000;
const DEFAULT_MODEL = "claude-sonnet-5-5";
/** After a failure the subscription is usually still failing: the usage limit, a lapsed token. */
const REST_MS = 2 * 60_000;

let running = 0;
let restingUntil = 0;
let restingFor = "";
/** Calls waiting for a slot, first come first served. */
let waiting: (() => void)[] = [];

export function bridgeSecretOk(given: string | null): boolean {
  const secret = (process.env.C141_CLAUDE_BRIDGE_SECRET ?? "").trim();
  if (secret.length < 16) return false;
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(given ?? ""), h(secret));
}

function concurrency(): number {
  const n = Number(process.env.C141_CLAUDE_MATCH_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

export type BridgeRequest = { task: BridgeTask; system: string; prompt: string };

/** The request, or why it is refused. Pure. */
export function readBridgeRequest(body: unknown): BridgeRequest | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!BRIDGE_TASKS.includes(b.task as BridgeTask)) return { error: "unknown task" };
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return { error: "no prompt" };
  const system = typeof b.system === "string" ? b.system : "";
  if (system.length + b.prompt.length > MAX_PROMPT) return { error: "prompt too long" };
  return { task: b.task as BridgeTask, system, prompt: b.prompt };
}

/** Why Claude will not be asked right now, or null when it may be. */
export function bridgeUnavailable(now = Date.now()): string | null {
  if (!claudeMatchOn()) return "off";
  if (now < restingUntil) return `resting: ${restingFor}`;
  if (running >= concurrency()) return "busy";
  return null;
}

/** For tests: forget any rest and any runs in flight. */
export function resetBridge() {
  running = 0;
  restingUntil = 0;
  restingFor = "";
  waiting = [];
}

/** Off or resting: no point waiting for a slot. */
function closed(now = Date.now()): string | null {
  if (!claudeMatchOn()) return "off";
  if (now < restingUntil) return `resting: ${restingFor}`;
  return null;
}

/** A slot, waiting up to waitMs for one; false when none came free in time. */
export function takeSlot(waitMs: number): Promise<boolean> {
  if (running < concurrency()) {
    running++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      running++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiting = waiting.filter((w) => w !== wake);
      resolve(false);
    }, waitMs);
    waiting.push(wake);
  });
}

export function releaseSlot() {
  running--;
  const next = waiting.shift();
  if (next) next();
}

export async function askBridge(r: BridgeRequest): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const why = closed();
  if (why) return { ok: false, reason: why };
  if (!(await takeSlot(CLAUDE_QUEUE_MS[r.task]))) return { ok: false, reason: "busy" };
  try {
    // It may have started resting while this call waited.
    const now = closed();
    if (now) return { ok: false, reason: now };
    const model = (process.env.C141_CLAUDE_MATCH_MODEL ?? "").trim() || DEFAULT_MODEL;
    const out = await runClaude(
      // No tools at all: it answers from the prompt, it does not act.
      ["--output-format", "stream-json", "--verbose", "--tools", "", "--model", model],
      r.system ? `${r.system}\n\n${r.prompt}` : r.prompt,
      TIMEOUT_MS,
    );
    logSubscriptionUsage(r.task, out.out);
    const { final } = readStream(out.out);
    const text = (final?.result ?? "").trim();
    const failed = out.timedOut
      ? `no answer in ${TIMEOUT_MS / 1000}s`
      : final?.is_error || (final?.subtype && final.subtype !== "success") || out.code !== 0 || !text
        ? `exited ${out.code}: ${(final?.result || out.err || "no answer").slice(0, 200)}`
        : null;
    if (failed) {
      restingUntil = Date.now() + REST_MS;
      restingFor = failed;
      console.warn(`[claude-bridge] ${r.task} failed, resting ${REST_MS / 1000}s: ${failed}`);
      return { ok: false, reason: failed };
    }
    return { ok: true, text };
  } finally {
    releaseSlot();
  }
}
