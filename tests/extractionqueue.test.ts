import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planTurns, isUrgentUpload, EXTRACTION_LEASE_MS, MAX_CONCURRENT_EXTRACTIONS, BACKGROUND_SLOTS } from "../convex/lib/extractionQueue";

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

test("background work never takes the last slot; a TA's own upload can", () => {
  assert.equal(BACKGROUND_SLOTS, MAX_CONCURRENT_EXTRACTIONS - 1);
  const twoBackground = [{ startedAt: now }, { startedAt: now }];
  const plan = planTurns(twoBackground, now, 3, 2);
  assert.equal(plan.free, 1, "one slot is still free…");
  assert.equal(plan.backgroundFree, 0, "…but only for a TA's upload");
  // Urgent readings do not use up the background share.
  const urgentHeld = planTurns([{ startedAt: now, urgent: true }], now, 3, 2);
  assert.equal(urgentHeld.free, 2);
  assert.equal(urgentHeld.backgroundFree, 2);
  assert.equal(planTurns([], now, 3, 2).backgroundFree, 2);
});

test("HH and Scoop uploads are the urgent ones", () => {
  assert.equal(isUrgentUpload({ headhuntedBy: "u1" }), true);
  assert.equal(isUrgentUpload({ scoopedBy: "u1" }), true);
  assert.equal(isUrgentUpload({}), false);
  assert.equal(isUrgentUpload(null), false);
});

test("HH and Scoop uploads join the line in their own mutation, ahead of background work", () => {
  for (const file of ["convex/ta/hhUpload.ts", "convex/ta/scoopUpload.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /await enqueueExtraction\(ctx, cvUploadId,/, file);
    assert.doesNotMatch(src, /runAfter\(0, internal\.cvs\.cvExtraction\.processCvExtraction/, file);
  }
  const queue = readFileSync("convex/cvs/cvUploads.ts", "utf8");
  const start = queue.slice(queue.indexOf("async function startNextTurns"), queue.indexOf("export async function inExtractionQueue"));
  assert.ok(start.indexOf('eq("urgent", true)') < start.indexOf('eq("urgent", undefined)'), "urgent CVs are started first");
});

test("a failed AI reading tells the TA why, not a guess", () => {
  const src = readFileSync("convex/cvs/cvExtraction.ts", "utf8");
  assert.doesNotMatch(src, /throw new Error\("LLM failed to extract candidate data \(API timeout or invalid response\)"\)/);
  assert.match(src, /callOpenRouterLLM\(ctx, cappedRawText, cvUploadId, sourceChannel, failure\)/);
  assert.match(src, /LLM failed to extract candidate data: \$\{failure\.reason/);
  // Every way the call comes back empty names its reason.
  const call = src.slice(src.indexOf("export async function callOpenRouterLLM"), src.indexOf("// null → undefined helper"));
  // The one bare `return null` is the reason-recording helper itself.
  assert.equal(call.match(/return null;/g)?.length, 1);
  const llm = readFileSync("convex/lib/llm.ts", "utf8");
  assert.match(llm, /primaryError/);
});
