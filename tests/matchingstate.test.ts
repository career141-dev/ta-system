/**
 * What the matching banner says (lib/matchingNow): running while the desk's
 * run is going, then finished, and never "running" for a run that died.
 */
import { clearMatching, markMatching, matchingMarks, matchingState } from "@/lib/matchingNow";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const now = 1_000_000_000_000;
const min = 60_000;
const base = { now, markedAt: null, failure: null, requirementsStatus: "extracted", engineStatus: null, engineAt: null, lastRun: null };
const kind = (o: Partial<Parameters<typeof matchingState>[0]>) => matchingState({ ...base, ...o }).kind;

console.log("\nthe desk's own run");
eq("asked a moment ago: running", kind({ markedAt: now - 5_000 }), "running");
eq("asked while the details are still being read: reading", kind({ markedAt: now - 5_000, requirementsStatus: "extracting" }), "reading");
eq("a mark from a dead process is ignored", kind({ markedAt: now - 30 * min }), "idle");
eq("a run that could not run says why", matchingState({ ...base, failure: { at: now - min, reason: "Approve the JD first" } }), { kind: "error", reason: "Approve the JD first" });

console.log("\nthe engine's status");
eq("engine running: running", kind({ engineStatus: "running", engineAt: now - min }), "running");
eq("engine running for 20 minutes: stopped", kind({ engineStatus: "running", engineAt: now - 20 * min }), "slow");
eq("engine error, nothing after it: error", kind({ engineStatus: "error", engineAt: now - min }), "error");
eq(
  "engine error but the desk's own route matched in the same run: finished",
  kind({ engineStatus: "error", engineAt: now - min, lastRun: { at: now - 2 * min, added: 4, note: null } }),
  "finished",
);

console.log("\nafterwards");
const done = matchingState({ ...base, engineStatus: "done", engineAt: now - min, lastRun: { at: now - 2 * min, added: 12, note: "x" } });
eq("finished, at the engine's end time, with the count", done, { kind: "finished", at: now - min, added: 12, note: "x" });
eq("an hour later: quiet", matchingState({ ...base, engineStatus: "done", engineAt: now - 60 * min, lastRun: { at: now - 61 * min, added: 3, note: null } }), { kind: "idle", lastAt: now - 61 * min });
eq("never matched", matchingState(base), { kind: "idle", lastAt: null });

console.log("\nmarks");
markMatching("op1", now);
eq("marked", matchingMarks("op1"), { markedAt: now, failure: null });
clearMatching("op1", "Matching did not run (x).");
eq("cleared with a reason", matchingMarks("op1").markedAt, null);
eq("the reason is kept", matchingMarks("op1").failure?.reason, "Matching did not run (x).");
markMatching("op1", now);
eq("a new run forgets the old failure", matchingMarks("op1").failure, null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
