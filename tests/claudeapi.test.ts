/**
 * Claude through the company's API key (src/lib/claudeApi): which tasks may
 * go there, and that anything it cannot answer falls back to OpenRouter.
 * No network — fetch is replaced for the whole file.
 */
import { viaClaudeApi } from "@/lib/claudeApi";
import { write } from "@/lib/ai";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const set = (v: Record<string, string | undefined>) => {
  for (const k of ["ANTHROPIC_API_KEY", "C141_CLAUDE_API_TASKS", "OPENROUTER_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "C141_CLAUDE_SUB_TASKS", "C141_SPEND_CAP_USD"]) delete process.env[k];
  Object.assign(process.env, v);
};

// Every request, and what Anthropic answers this time.
const calls: { url: string; body: Record<string, unknown> }[] = [];
let anthropic: () => Response = () => new Response("{}", { status: 500 });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
  if (String(url).includes("anthropic.com")) return anthropic();
  return Response.json({ choices: [{ message: { content: "from openrouter" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
}) as typeof fetch;
const claude = (body: object) => () => Response.json(body);

console.log("\nwho may use the Claude API");
set({ C141_CLAUDE_API_TASKS: "plan" });
eq("no key: nothing goes to it", viaClaudeApi("plan"), false);
set({ ANTHROPIC_API_KEY: "k", C141_CLAUDE_API_TASKS: "plan, research" });
eq("research and benchmark do, once named", [viaClaudeApi("plan"), viaClaudeApi("research")], [true, true]);
eq("a task not named does not", viaClaudeApi("jd"), false);
set({ ANTHROPIC_API_KEY: "k", C141_CLAUDE_API_TASKS: "rank,parse,extract,assist" });
eq("CV and message tasks are refused even when named", ["rank", "parse", "extract", "assist"].map((t) => viaClaudeApi(t as never)), [false, false, false, false]);
set({ ANTHROPIC_API_KEY: "k" });
eq("nothing named: off", viaClaudeApi("plan"), false);

async function main() {
  console.log("\nClaude answers");
  set({ ANTHROPIC_API_KEY: "k", C141_CLAUDE_API_TASKS: "plan", OPENROUTER_API_KEY: "o" });
  calls.length = 0;
  anthropic = claude({ model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":1}' }] });
  let r = await write("sys", "prompt", 600, "plan");
  eq("its text comes back, thinking left out", r.ok && r.text, '{"a":1}');
  eq("and says who answered", r.ok && r.provider, "anthropic/claude-opus-5 · plan");
  eq("OpenRouter is not asked", calls.map((c) => new URL(c.url).hostname), ["api.anthropic.com"]);
  eq("room for thinking beyond the caller's 600 tokens", calls[0].body.max_tokens, 16000);
  eq("no temperature (this model refuses one)", "temperature" in calls[0].body, false);

  console.log("\nwhatever Claude cannot answer goes to OpenRouter");
  const cases: [string, () => Response][] = [
    ["rate limited", () => new Response("", { status: 429 })],
    ["declined", claude({ stop_reason: "refusal", content: [] })],
    ["cut off mid-answer", claude({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"a":' }] })],
    ["an error", () => new Response("overloaded", { status: 529 })],
    ["an empty answer", claude({ stop_reason: "end_turn", content: [] })],
  ];
  for (const [label, answer] of cases) {
    calls.length = 0;
    anthropic = answer;
    r = await write("sys", "prompt", 600, "plan");
    eq(label, [r.ok && r.text, calls.map((c) => new URL(c.url).hostname)], ["from openrouter", ["api.anthropic.com", "openrouter.ai"]]);
  }

  console.log("\nnot set up: as before");
  set({ OPENROUTER_API_KEY: "o" });
  calls.length = 0;
  r = await write("sys", "prompt", 600, "plan");
  eq("straight to OpenRouter", calls.map((c) => new URL(c.url).hostname), ["openrouter.ai"]);
  set({ ANTHROPIC_API_KEY: "k", C141_CLAUDE_API_TASKS: "plan", OPENROUTER_API_KEY: "o" });
  calls.length = 0;
  r = await write("sys", "prompt", 600, "rank");
  eq("a CV task never reaches Claude", calls.map((c) => new URL(c.url).hostname), ["openrouter.ai"]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
