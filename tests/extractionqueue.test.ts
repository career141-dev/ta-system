import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planTurns, EXTRACTION_LEASE_MS, MAX_CONCURRENT_EXTRACTIONS } from "../convex/lib/extractionQueue";

const now = 100 * 60_000;

test("free slots are the limit less the readings in progress", () => {
  assert.equal(planTurns([], now).free, MAX_CONCURRENT_EXTRACTIONS);
  assert.equal(planTurns([{ startedAt: now - 1_000 }], now, 3).free, 2);
  const full = [{ startedAt: now }, { startedAt: now }, { startedAt: now }];
  assert.equal(planTurns(full, now, 3).free, 0);
  // More held than the limit (the limit was lowered) is not a negative count.
  assert.equal(planTurns([...full, { startedAt: now }], now, 3).free, 0);
});

test("a slot whose reading died is taken back and freed", () => {
  const dead = { id: "dead", startedAt: now - EXTRACTION_LEASE_MS - 1 };
  const live = { id: "live", startedAt: now - 200_000 };
  const plan = planTurns([dead, live, { id: "x", startedAt: now }], now, 3);
  assert.deepEqual(plan.lapsed.map((r) => r.id), ["dead"]);
  assert.equal(plan.free, 1);
});

test("a live reading never loses its slot before the runtime would kill it", () => {
  // The reading stops itself at 210s; the slot outlasts it with room to spare.
  assert.ok(EXTRACTION_LEASE_MS > 300_000);
  assert.equal(planTurns([{ startedAt: now - 300_000 }], now, 3).lapsed.length, 0);
});

test("a reading over the limit waits in the queue rather than rescheduling itself", () => {
  const src = readFileSync("convex/cvs/cvExtraction.ts", "utf8");
  const action = src.slice(src.indexOf("export const processCvExtraction"), src.indexOf("// Batch Resume"));
  assert.match(action, /enterExtractionQueue/);
  assert.match(action, /leaveExtractionQueue/);
  // The old busy-wait: a run that missed a slot scheduled itself again.
  assert.doesNotMatch(action, /runAfter\([^)]*processCvExtraction/);
});

test("the two-minute queue does not start a second run for a CV already waiting", () => {
  const src = readFileSync("convex/cvs/cvUploads.ts", "utf8");
  const claim = src.slice(src.indexOf("export const claimUploadedBatch ="), src.indexOf("export const claimUploadedBatchPublic"));
  assert.match(claim, /inExtractionQueue/);
  const requeue = src.slice(src.indexOf("export const requeueAllStuckUploads"), src.indexOf("export const recoverCreditDepletedCVs"));
  assert.match(requeue, /inExtractionQueue/);
});

test("every reading is counted, so a failing CV stops being retried", () => {
  const src = readFileSync("convex/cvs/cvExtraction.ts", "utf8");
  assert.match(src, /status: "processing",\s*processingStartedAt: Date\.now\(\),\s*processingStage: "downloading",\s*countAttempt: true/);
});
