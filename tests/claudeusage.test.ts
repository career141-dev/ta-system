/**
 * How much of the Claude subscription this platform draws.
 *
 * The plan is a flat $100 a month, so nothing was ever counted — the bill does
 * not move. But that leaves no way to answer the question actually asked
 * (2 October): not what the plan costs, but how much of it THIS platform uses,
 * and whether the same work would cost cents on the metered key.
 *
 * `askSubscription` ran with `--output-format text`, which prints the answer
 * and throws the usage away. These cover reading it back out of the
 * `stream-json` result event, and pricing it as the API would have.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SHADOW_RATE,
  readClaudeUsage,
  shadowCostUsd,
  totalTokens,
} from "../src/lib/claudeUsage";

/** One `--output-format stream-json` run, as the CLI emits it. */
const stream = (result: Record<string, unknown>) =>
  [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({ type: "result", ...result }),
  ].join("\n");

test("reads the token counts out of the result event", () => {
  const u = readClaudeUsage(
    stream({
      result: "done",
      model: "claude-sonnet-4-5",
      duration_ms: 8400,
      usage: { input_tokens: 12_000, output_tokens: 1_500, cache_read_input_tokens: 40_000 },
    }),
  );
  assert.ok(u);
  assert.equal(u.inputTokens, 12_000);
  assert.equal(u.outputTokens, 1_500);
  assert.equal(u.cacheReadTokens, 40_000);
  assert.equal(u.model, "claude-sonnet-4-5");
  assert.equal(u.durationMs, 8400);
  assert.equal(totalTokens(u), 53_500);
});

test("prices cached reads at a tenth of input, as Anthropic bills them", () => {
  // Research prompts repeat a lot of context, so this is not a rounding detail.
  const u = readClaudeUsage(
    stream({ model: "claude-sonnet-4-5", usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 } }),
  );
  const cached = readClaudeUsage(
    stream({ model: "claude-sonnet-4-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } }),
  );
  assert.equal(shadowCostUsd(u), 3, "1M input at $3/M");
  assert.equal(shadowCostUsd(cached), 0.3, "the same cached is a tenth");
});

test("output is priced five times input on Sonnet", () => {
  const u = readClaudeUsage(
    stream({ model: "claude-sonnet-4-5", usage: { input_tokens: 0, output_tokens: 1_000_000 } }),
  );
  assert.equal(shadowCostUsd(u), 15);
  assert.equal(DEFAULT_SHADOW_RATE.output / DEFAULT_SHADOW_RATE.input, 5);
});

test("an unknown model is priced as Sonnet rather than free", () => {
  const u = readClaudeUsage(
    stream({ model: "some-future-model", usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
  );
  assert.equal(shadowCostUsd(u), 3, "a model we do not know must not price at zero");
});

test("a result event with no usage is unknown, not zero", () => {
  // Saying zero would quietly under-report a shape we failed to parse.
  assert.equal(readClaudeUsage(stream({ result: "done" })), null);
  assert.equal(readClaudeUsage(stream({ result: "done", usage: {} })), null);
  assert.equal(
    readClaudeUsage(stream({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } })),
    null,
  );
});

test("no result event at all means nothing to count", () => {
  assert.equal(readClaudeUsage(""), null);
  assert.equal(readClaudeUsage("not json at all"), null);
  assert.equal(readClaudeUsage(JSON.stringify({ type: "system" })), null);
  assert.equal(shadowCostUsd(null), 0);
  assert.equal(totalTokens(null), 0);
});

test("a stream cut short by the timeout kill still yields the earlier result", () => {
  // The CLI is killed at two minutes; the last line is often half-written.
  const cut =
    JSON.stringify({ type: "result", model: "claude-sonnet-4-5", usage: { input_tokens: 500, output_tokens: 50 } }) +
    '\n{"type":"assist';
  const u = readClaudeUsage(cut);
  assert.ok(u);
  assert.equal(u.inputTokens, 500);
});

test("negative or non-numeric counts are ignored, never trusted", () => {
  const u = readClaudeUsage(
    stream({ model: "claude-sonnet-4-5", usage: { input_tokens: -5, output_tokens: "many", cache_read_input_tokens: 100 } }),
  );
  assert.ok(u);
  assert.equal(u.inputTokens, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.cacheReadTokens, 100);
});
