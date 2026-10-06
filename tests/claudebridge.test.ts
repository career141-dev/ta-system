/**
 * Claude first for the backend's matching (src/lib/claudeBridge, convex/lib/
 * claudeFirst). The rules under test: only the secret holder gets in; only the
 * matching tasks are accepted; when Claude is off, resting or busy the answer
 * is "no" at once, so the backend goes to DeepSeek; and the backend side never
 * throws — any failure is a null, which means DeepSeek.
 */
import { bridgeSecretOk, bridgeUnavailable, readBridgeRequest, releaseSlot, resetBridge, takeSlot } from "@/lib/claudeBridge";
import { answerInProcess, askClaudeFirst, CLAUDE_ANSWER_MS, claudeBudgetMs, jsonIn } from "../convex/lib/claudeFirst";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const set = (v: Record<string, string | undefined>) => {
  for (const k of ["C141_CLAUDE_BRIDGE_SECRET", "CLAUDE_CODE_OAUTH_TOKEN", "C141_CLAUDE_MATCH", "C141_APP_INTERNAL_URL"]) delete process.env[k];
  Object.assign(process.env, v);
};
const SECRET = "a-long-enough-test-secret";

console.log("\nwho gets in");
set({});
eq("no secret set: nobody", bridgeSecretOk(SECRET), false);
set({ C141_CLAUDE_BRIDGE_SECRET: "short" });
eq("a secret too short to trust: nobody", bridgeSecretOk("short"), false);
set({ C141_CLAUDE_BRIDGE_SECRET: SECRET });
eq("the right secret", bridgeSecretOk(SECRET), true);
eq("the wrong one", bridgeSecretOk("a-long-enough-wrong-secret"), false);
eq("none given", bridgeSecretOk(null), false);

console.log("\nwhat may be asked");
eq("a matching task", readBridgeRequest({ task: "match_score", system: "s", prompt: "p" }), { task: "match_score", system: "s", prompt: "p" });
eq("extraction is not matching", readBridgeRequest({ task: "cv_structuring", prompt: "p" }), { error: "unknown task" });
eq("no prompt", readBridgeRequest({ task: "match_rank", prompt: "  " }), { error: "no prompt" });
eq("too long", readBridgeRequest({ task: "match_role", prompt: "x".repeat(70_000) }), { error: "prompt too long" });
eq("not JSON at all", readBridgeRequest(null), { error: "unknown task" });

console.log("\nwhen Claude is not asked");
resetBridge();
set({ C141_CLAUDE_BRIDGE_SECRET: SECRET });
eq("switch off: off", bridgeUnavailable(), "off");
set({ C141_CLAUDE_BRIDGE_SECRET: SECRET, C141_CLAUDE_MATCH: "on", CLAUDE_CODE_OAUTH_TOKEN: "t" });
eq("switch on, nothing running: ask", bridgeUnavailable(), null);

console.log("\nthe backend side");
{
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  let called = 0;
  const counting = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;

  set({});
  eq("no address or secret: DeepSeek, without asking", [await askClaudeFirst("match_score", "", "p", 1000, counting), called], [null, 0]);
  set({ C141_APP_INTERNAL_URL: "http://app:3000/", C141_CLAUDE_BRIDGE_SECRET: SECRET });
  eq("an answer", await askClaudeFirst("match_score", "", "p", 1000, ok({ ok: true, text: '{"score":70}' })), '{"score":70}');
  eq("busy (503): DeepSeek", await askClaudeFirst("match_score", "", "p", 1000, ok({ ok: false, reason: "busy" }, 503)), null);
  eq("an empty answer: DeepSeek", await askClaudeFirst("match_score", "", "p", 1000, ok({ ok: true, text: " " })), null);
  eq("not JSON: DeepSeek", await askClaudeFirst("match_score", "", "p", 1000, (async () => new Response("<html>")) as unknown as typeof fetch), null);
  eq("the app down: DeepSeek", await askClaudeFirst("match_score", "", "p", 1000, (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch), null);
  // A request still open holds the process, as a real socket would; the
  // timeout must end it long before this one would answer.
  const slow = ((_: unknown, init: RequestInit) => new Promise((resolve, reject) => {
    const answerLate = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, text: "late" }))), 5_000);
    init.signal!.addEventListener("abort", () => { clearTimeout(answerLate); reject(init.signal!.reason); });
  })) as unknown as typeof fetch;
  eq("too slow: DeepSeek", await askClaudeFirst("match_rank", "", "p", 50, slow), null);
  let sent: { url?: string; secret?: string | null; body?: unknown } = {};
  const spy = (async (url: string, init: RequestInit) => {
    sent = { url, secret: new Headers(init.headers).get("x-c141-secret"), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ ok: true, text: "x" }));
  }) as unknown as typeof fetch;
  await askClaudeFirst("match_role", "sys", "the prompt", 1000, spy);
  eq("asks the app's private route with the secret", sent, { url: "http://app:3000/api/internal/claude", secret: SECRET, body: { task: "match_role", system: "sys", prompt: "the prompt" } });
}

console.log("\nwaiting for a slot (6 Oct)");
{
  resetBridge();
  set({ C141_CLAUDE_BRIDGE_SECRET: SECRET, C141_CLAUDE_MATCH: "on", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  for (let i = 0; i < 3; i++) await takeSlot(0);
  eq("three running: the next is told busy", bridgeUnavailable(), "busy");
  const queued = takeSlot(1_000);
  releaseSlot();
  eq("one finishes: the waiting call gets its slot", await queued, true);
  eq("and a call that cannot wait any longer is turned away", await takeSlot(20), false);
  resetBridge();
}

console.log("\nthe time each call allows");
for (const t of ["match_role", "match_score", "match_rank"] as const) {
  eq(`${t}: longer than one Claude answer`, claudeBudgetMs(t) > CLAUDE_ANSWER_MS, true);
}
eq("a search, where a TA is waiting, waits less than background scoring", claudeBudgetMs("match_rank") < claudeBudgetMs("match_score"), true);

console.log("\ninside the app (database search)");
{
  set({});
  let asked = 0;
  const neverCalled = (async () => { asked++; return new Response("{}"); }) as unknown as typeof fetch;
  answerInProcess(async (task, _s, prompt) => `${task}:${prompt}`);
  eq("asks in the process, not over the network, with no address set", [await askClaudeFirst("match_rank", "", "p", 1000, neverCalled), asked], ["match_rank:p", 0]);
  answerInProcess(async () => null);
  eq("no answer in the process: DeepSeek", await askClaudeFirst("match_rank", "", "p", 1000, neverCalled), null);
  answerInProcess(async () => { throw new Error("spawn failed"); });
  eq("a throw in the process: DeepSeek, not a throw", await askClaudeFirst("match_rank", "", "p", 1000, neverCalled), null);
  answerInProcess(null);
  eq("cleared: back to the network rules", await askClaudeFirst("match_rank", "", "p", 1000, neverCalled), null);
}

console.log("\nreading the answer");
eq("plain JSON", jsonIn('{"score": 80}'), { score: 80 });
eq("in a code fence", jsonIn('```json\n{"score": 80}\n```'), { score: 80 });
eq("with words around it", jsonIn('Here it is: {"score": 80} — done'), { score: 80 });
eq("no JSON", jsonIn("I cannot judge this."), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
