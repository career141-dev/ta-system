/**
 * Runs every end-to-end phase script in order and reports the total.
 *
 *   npm run e2e
 *
 * Needs the local Convex backend (crons off, outbound lock on) and the dev
 * server on :3177 with C141_DEV_SIGNIN=on. Each script cleans up after itself
 * and finishes with ta/testSweep, so a run leaves no test data behind.
 * P3 reads the mailbox in P3_INBOX (default sanjeev@career141.com), read-only.
 */
import { spawnSync } from "node:child_process";

const phases = ["p1-foundation", "p2-openings", "p3-ingestion", "p4-profiles-search", "p5-pipeline", "p7-desk"];
let passed = 0;
let failed = 0;
const bad = [];
for (const p of phases) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--conditions=react-server", "--import", "./tests/alias.mjs", `scripts/e2e/${p}.ts`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout}${r.stderr}`;
  const m = out.match(/(\d+) passed, (\d+) failed/g)?.pop()?.match(/(\d+) passed, (\d+) failed/);
  const ok = m ? Number(m[1]) : 0;
  const ko = m ? Number(m[2]) : 1;
  passed += ok;
  failed += ko;
  if (ko || r.status !== 0) bad.push(p);
  console.log(`${p.padEnd(20)} ${ok} passed, ${ko} failed  (${Math.round((Date.now() - started) / 1000)}s)`);
  for (const line of out.split("\n").filter((l) => /^\s+FAIL /.test(l))) console.log(`  ${line.trim()}`);
}
console.log(`\n${passed} passed, ${failed} failed${bad.length ? ` — failing: ${bad.join(", ")}` : ""}`);
process.exit(failed ? 1 : 0);
