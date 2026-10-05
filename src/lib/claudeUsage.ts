// src/lib/claudeUsage.ts
//
// How much of the Claude subscription this platform actually consumes.
//
// The subscription is a flat $100 a month, so nothing was ever counted — the
// bill does not move. But the owner asked the right question (2 October): not
// "what is the plan costing" but "how much of it is THIS platform using".
// Without that, there is no way to tell whether the $100 is earning its keep
// or whether the same work would cost cents on the metered key.
//
// Nothing measured it. `askSubscription` ran the CLI with
// `--output-format text`, which prints the answer and throws the usage away.
// The CLI does report it under `--output-format stream-json`, in the final
// `result` event, which the search path already uses for grounding.
//
// Marginal cost is zero: the tokens are inside a fee already paid. What is
// worth knowing is the SHADOW cost — what those same tokens would have cost on
// the API — because that is the number to hold against $100.
//
// Pure: no imports, so it is tested without a subscription
// (tests/claudeusage.test.ts).

/**
 * Anthropic list prices, USD per million tokens, as of October 2026.
 *
 * Used only to price the shadow cost, never to bill anything. The model the
 * CLI picks is whatever the subscription serves, so this is an estimate of
 * what the work would have cost, not what it did.
 */
export const CLAUDE_API_RATES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Priced as Sonnet when the stream does not name a model we know. */
export const DEFAULT_SHADOW_RATE = { input: 3, output: 15 };

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** The model the CLI reported, when it reported one. */
  model?: string;
  /** Milliseconds the run took, as the CLI measured it. */
  durationMs?: number;
};

/**
 * The usage line out of a `--output-format stream-json` run.
 *
 * Reads the final `result` event. Tolerant on purpose: the CLI's event shape
 * is not a contract we control, so a missing or renamed field costs a zero in
 * a report, never a thrown error in the middle of a candidate's research.
 */
export function readClaudeUsage(stream: string): ClaudeUsage | null {
  let result: Record<string, unknown> | null = null;
  for (const line of stream.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const e = JSON.parse(t) as Record<string, unknown>;
      if (e.type === "result") result = e;
    } catch {
      // A line cut short by a timeout kill; the rest still counts.
    }
  }
  if (!result) return null;

  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

  const inputTokens = n(usage.input_tokens);
  const outputTokens = n(usage.output_tokens);
  const cacheReadTokens = n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);

  // A result event with no usage at all is not usage of zero — it is a shape
  // we did not understand, and saying zero would quietly under-report.
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) return null;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    model: typeof result.model === "string" ? result.model : undefined,
    durationMs: typeof result.duration_ms === "number" ? result.duration_ms : undefined,
  };
}

/**
 * What these tokens would have cost on the API.
 *
 * Cached reads are billed at a tenth of input by Anthropic, so they are priced
 * that way rather than ignored — Research prompts repeat a lot of the same
 * context and the difference is not small.
 */
export function shadowCostUsd(u: ClaudeUsage | null): number {
  if (!u) return 0;
  const rate = (u.model && CLAUDE_API_RATES_USD_PER_MTOK[u.model]) || DEFAULT_SHADOW_RATE;
  const dollars =
    (u.inputTokens * rate.input + u.cacheReadTokens * rate.input * 0.1 + u.outputTokens * rate.output) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/** Total tokens drawn from the subscription, for the usage figure itself. */
export function totalTokens(u: ClaudeUsage | null): number {
  return u ? u.inputTokens + u.outputTokens + u.cacheReadTokens : 0;
}
