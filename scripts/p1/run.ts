/**
 * P1 runner (14 September). Two modes:
 *
 *   --dry-run   Free. Runs the real frozen manifest and all 240 requests against a
 *               fake provider in a scratch folder. Sends nothing.
 *               --scenario normal|flaky|long|nocost|outage|overcharge|badanswer|restart
 *
 *   --paid      Sends the frozen requests. Refuses to start unless all hold:
 *               - C141_P1_APPROVAL equals "<manifest hash>:<runner hash>", both
 *                 printed by --dry-run: the approval names the exact requests and
 *                 the exact runner code that was reviewed
 *               - C141_P1_OPENROUTER_KEY is set and is not the platform key
 *               - --cap equals the manifest allowance
 *
 * Both modes write final.json: every manifest request exactly once.
 *
 * C141_DATA_DIR=$PWD/.data-live-test node --import ./tests/alias.mjs scripts/p1/run.ts --dry-run
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }
if (!(process.env.C141_DATA_DIR ?? "").trim()) { console.error("Set C141_DATA_DIR to the test folder."); process.exit(1); }

const { dataDir } = await import("@/data/dataDir");
const { RunLedger } = await import("@/lib/runLedger");
const { runFrozen, manifestHash, writeFinalReport } = await import("@/lib/p1Runner");
import type { FrozenRequest, Manifest } from "@/lib/p1Runner";

const has = (f: string) => process.argv.includes(`--${f}`);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const frozenDir = path.join(dataDir(), "runs", "P1");
const manifest = JSON.parse(fs.readFileSync(path.join(frozenDir, "manifest.json"), "utf8")) as Manifest & { cost: { worstCaseUsd: number } };
const requests = fs.readFileSync(path.join(frozenDir, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FrozenRequest);
const hash = manifestHash(manifest);
/** The runner's behaviour is frozen too: these files decide what is sent and what is counted. */
const RUNNER_FILES = ["src/lib/p1Runner.ts", "src/lib/runLedger.ts", "src/lib/screenAnswer.ts", "scripts/p1/run.ts"];
const runnerHash = crypto.createHash("sha256").update(RUNNER_FILES.map((f) => `${f}\n${fs.readFileSync(path.join(process.cwd(), f), "utf8")}`).join("\n")).digest("hex");
const approvalNeeded = `${hash}:${runnerHash}`;

const validAnswer = (decision: string) => JSON.stringify({
  industry: { result: "pass", quote: "" }, level: { current: "manager", job: "manager", result: "pass", quote: "" },
  work: { type: "procurement", result: decision === "reject" ? "fail" : "pass", quote: "" }, essentials_contradicted: [], essentials_missing: [],
  move: "step_up", decision, reason: "dry run",
});

if (has("dry-run")) {
  const scratch = arg("scratch") ?? fs.mkdtempSync(path.join(os.tmpdir(), "c141-p1-dry-"));
  let calls = 0;
  const scenario = arg("scenario") ?? "normal";
  const fake: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (body.provider.allow_fallbacks !== false || body.provider.zdr !== true || body.provider.data_collection !== "deny") throw new Error("unsafe request body");
    const promptTokens = Math.ceil((body.messages[0].content.length + body.messages[1].content.length) / 4);
    if (scenario === "flaky" && calls % 37 === 0) throw new TypeError("fetch failed");
    if (scenario === "flaky" && calls % 41 === 0) return new Response("upstream error", { status: 502 });
    const out = scenario === "long" ? body.max_tokens : 300;
    const rt = manifest.routes.find((r) => r.model === body.model)!;
    let cost: number | undefined = (promptTokens * rt.inPerM + out * rt.outPerM) / 1e6;
    if (scenario === "nocost") cost = undefined;
    if (scenario === "overcharge" && calls === 50) cost = 0.05;
    const content = scenario === "long" ? '{"decision":' : scenario === "badanswer" && calls % 3 === 0 ? (calls % 2 ? "{}" : '{"decision":"hire"}') : validAnswer(calls % 5 === 0 ? "maybe" : "reject");
    return new Response(JSON.stringify({ id: `dry-${calls}`, choices: [{ finish_reason: scenario === "long" ? "length" : "stop", message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: out, ...(cost === undefined ? {} : { cost }) } }), { status: 200 });
  };
  const run = async (label: string, fetchImpl: typeof fetch) => {
    const L = new RunLedger(scratch, "P1", manifest.capUsd, hash, runnerHash); L.open();
    try {
      const out = await runFrozen({ manifest, requests, ledger: L, key: "dry-run", resultsFile: path.join(scratch, "results.jsonl"), fetchImpl });
      const summary = writeFinalReport({ manifest, requests, ledger: L, resultsFile: path.join(scratch, "results.jsonl"), stopped: out.stopped, outFile: path.join(scratch, "final.json") });
      const final = JSON.parse(fs.readFileSync(path.join(scratch, "final.json"), "utf8")) as { rows: { id: string }[] };
      const ids = final.rows.map((r) => r.id);
      console.log(JSON.stringify({ label, stopped: out.stopped, statusByModel: summary.statusByModel, ledger: summary.ledger, finalCoversManifest: ids.length === 240 && new Set(ids).size === 240 && requests.every((r) => ids.includes(r.id)) }));
    } finally { L.close(); }
  };
  console.log(`approval string for this manifest and runner: ${approvalNeeded}\nscenario ${scenario} · ${requests.length} frozen requests · allowance $${manifest.capUsd} · reservations total $${manifest.cost.worstCaseUsd}`);
  if (scenario === "outage") {
    await run("provider down", async () => { calls++; return new Response("down", { status: 503 }); });
  } else if (scenario === "crashchild") {
    const L = new RunLedger(scratch, "P1", manifest.capUsd, hash, runnerHash); L.open();
    const dying: typeof fetch = async (u, i) => { if (calls >= 100) process.exit(9); return fake(u, i); };
    await runFrozen({ manifest, requests, ledger: L, key: "dry-run", resultsFile: path.join(scratch, "results.jsonl"), fetchImpl: dying });
  } else if (scenario === "restart") {
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], "--dry-run", "--scenario", "crashchild", "--scratch", scratch], { env: process.env, encoding: "utf8" });
    console.log(JSON.stringify({ label: "child killed mid-request", exitCode: child.status, lockLeftBehind: fs.existsSync(path.join(scratch, "ledger.lock")) }));
    try { await run("restart without removing the lock", fake); } catch (e) { console.log(JSON.stringify({ label: "restart refused", reason: (e as Error).message.slice(0, 60) })); }
    fs.rmSync(path.join(scratch, "ledger.lock"));
    await run("restart after a person removes the lock", fake);
  } else if (scenario === "overcharge") {
    await run("request 50 charged above its reservation", fake);
    const before = calls;
    await run("restart while halted", fake);
    console.log(JSON.stringify({ label: "requests sent on restart while halted", sent: calls - before }));
  } else await run("first pass", fake);
  console.log(`fake provider calls: ${calls}`);
  process.exit(0);
}

if (has("paid")) {
  const approval = (process.env.C141_P1_APPROVAL ?? "").trim();
  const key = (process.env.C141_P1_OPENROUTER_KEY ?? "").trim();
  if (approval !== approvalNeeded) { console.error("Not approved: C141_P1_APPROVAL must equal the approval string printed by --dry-run (manifest hash and runner hash)."); process.exit(1); }
  if (!key) { console.error("Set C141_P1_OPENROUTER_KEY to the dedicated, spending-limited test key."); process.exit(1); }
  if (key === (process.env.OPENROUTER_API_KEY ?? "").trim()) { console.error("Refused: that is the platform key, not a dedicated test key."); process.exit(1); }
  if (Number(arg("cap")) !== manifest.capUsd) { console.error(`Pass --cap ${manifest.capUsd} to confirm the approved allowance.`); process.exit(1); }
  const L = new RunLedger(frozenDir, "P1", manifest.capUsd, hash, runnerHash);
  console.log(JSON.stringify({ opening: L.open() }));
  try {
    const resultsFile = path.join(frozenDir, "results.jsonl");
    const out = await runFrozen({ manifest, requests, ledger: L, key, resultsFile, log: (s) => console.log(s) });
    const summary = writeFinalReport({ manifest, requests, ledger: L, resultsFile, stopped: out.stopped, outFile: path.join(frozenDir, "final.json") });
    console.log(JSON.stringify(summary));
  } finally { L.close(); }
  process.exit(0);
}

console.log(`approval string: ${approvalNeeded}\nUse --dry-run [--scenario …] (free) or --paid (needs approval).`);
process.exit(0);
