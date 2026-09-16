import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spend-"));
process.env.C141_DATA_DIR = tmp;
process.env.OPENROUTER_API_KEY = "test-key";
process.env.SERPER_API_KEY = "test-key";
const calls: string[] = [];
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  calls.push(String(url));
  if (String(url).includes("serper")) return new Response(JSON.stringify({ organic: [], credits: 1 }), { status: 200 });
  if (String(url).includes("embeddings")) {
    const n = JSON.parse(init!.body!).input.length;
    return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [1, 0] })), usage: { total_tokens: 1000 } }), { status: 200 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.4 } }), { status: 200 });
}) as typeof fetch;

const { write } = await import("@/lib/ai");
const { search } = await import("@/lib/serper");
const { spentSoFar, TEST_CAP_USD, reserve } = await import("@/lib/spend");

console.log("\nthe test's hard stop");
eq("the cap is $5", TEST_CAP_USD, 5);
const r1 = await write("s", "p", 100, "rank");
eq("a call under the cap runs", r1.ok, true);
eq("and the real charge is recorded", spentSoFar(), 0.4);
eq("searches are metered", (await search("x")).error ?? null, null);
eq("at a tenth of a cent", spentSoFar(), 0.401);

// Spend right up to the cap, then ask for one more.
const top = reserve("filler", 4.5);
top(4.5);
const before = calls.length;
// A dear model, named outright: the JD task's default is DeepSeek now, and at
// its price this call would fit under the cap and prove nothing.
process.env.C141_MODEL_JD = "anthropic/claude-opus-5";
const r2 = await write("s", "p".repeat(2000), 8000, "jd");
delete process.env.C141_MODEL_JD;
eq("a call that could pass the cap is refused", r2.ok ? "ran" : r2.reason, "spend_cap");
eq("and nothing was sent", calls.length, before);
eq("a cheap search still fits under it", (await search("x")).error ?? null, null);
reserve("filler", 0.098)(0.098);
eq("but not once the cap is reached", (await search("x")).error, "spend_cap");
eq("the ledger survives a restart", JSON.parse(fs.readFileSync(path.join(tmp, "spend.json"), "utf8")).spent, 5);
eq("never above the cap", spentSoFar() <= TEST_CAP_USD, true);

console.log("\nunknown charges and a damaged ledger");
{
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "spend-fail-"));
  process.env.C141_DATA_DIR = t2;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const failed = await write("s", "p".repeat(300), 1000, "jd");
  eq("a request that got no answer fails", failed.ok, false);
  eq("and its charge is recorded at the maximum, not as free", spentSoFar() > 0, true);
  globalThis.fetch = real;
  fs.writeFileSync(path.join(t2, "spend.json"), "{damaged");
  const refused = await write("s", "p", 100, "jd");
  eq("an unreadable ledger stops paid calls", refused.ok ? "ran" : refused.reason, "spend_cap");
  eq("and a search too", (await search("x")).error, "spend_cap");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
