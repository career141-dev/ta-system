import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { uploadProgress } from "../convex/lib/cvUploadProgress";

const base = { status: "processing", _creationTime: 1_000, queuedAt: 2_000, processingStartedAt: 3_000 };

test("real extraction stages provide honest phase progress", () => {
  const queued = uploadProgress({ ...base, status: "queued", processingStage: "queued" }, null, 13_000);
  assert.equal(queued.state, "reading");
  assert.equal(queued.progress, 8);
  assert.match(queued.label, /Waiting/);

  const ai = uploadProgress({ ...base, processingStage: "structuring" }, null, 13_000);
  assert.equal(ai.state, "reading");
  assert.equal(ai.progress, 62);
  assert.match(ai.label, /all CV details/);
  assert.equal(ai.elapsedMs, 10_000);
});

test("every terminal extraction failure stops the spinner", () => {
  for (const status of ["failed", "failed_retry", "extraction_failed_permanent", "cancelled", "paused", "needs_review"]) {
    assert.equal(uploadProgress({ ...base, status }, null, 13_000).state, "failed", status);
  }
});

test("business completion wins only after the candidate is filed", () => {
  const saving = uploadProgress({ ...base, processingStage: "saving" }, "done", 13_000);
  assert.equal(saving.state, "reading");
  const filed = uploadProgress({ ...base, processingStage: "completed", completedAt: 12_000 }, "done", 13_000);
  assert.equal(filed.state, "done");
  assert.equal(filed.progress, 100);
  assert.equal(filed.elapsedMs, 9_000);
});

test("the extraction does not run OCR again after a full-text AI failure", () => {
  const source = readFileSync(new URL("../convex/cvs/cvExtraction.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /if \(!extracted\)[\s\S]{0,300}extractTextWithTesseract/);
  assert.match(source, /trimmed\.length < 50 && !ocrAttempted/);
});

test("a missed worker waits in the queue and is started when a slot frees", () => {
  // 26 Oct: the 4–6s reschedule became a busy-wait with 800 CVs queued; the
  // queue itself is covered in extractionqueue.test.ts.
  const source = readFileSync(new URL("../convex/cvs/cvExtraction.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /const later = 4_000 \+ Math\.floor\(Math\.random\(\) \* 2_000\)/);
  assert.doesNotMatch(source, /const later = 30_000 \+ Math\.floor\(Math\.random\(\) \* 30_000\)/);
  assert.match(source, /enterExtractionQueue/);
});


test("thin CVs try Haiku before NVIDIA and preserve the normal PDF path", () => {
  const source = readFileSync(new URL("../convex/cvs/cvExtraction.ts", import.meta.url), "utf8");
  const llm = readFileSync(new URL("../convex/lib/llm.ts", import.meta.url), "utf8");
  const vision = source.slice(source.indexOf("async function readThinCvWithVision"), source.indexOf("export async function extractText("));
  assert.ok(vision.indexOf("callHaikuVisionOCR") < vision.indexOf("callNvidiaVisionOCR"));
  assert.match(vision, /cleanRawText\(text\)\.trim\(\)\.length >= 50/);
  assert.match(vision, /HAIKU_MAX_BYTES/);
  assert.match(source, /cleanRawText\(pdfText\)\.trim\(\)\.length >= 50/);
  assert.match(llm, /anthropic\/claude-haiku-4\.5/);
  assert.match(llm, /type: "file"/);
  assert.match(llm, /finish_reason === "length"/);
  assert.doesNotMatch(llm, /google\/gemini-2\.0-flash-lite-001/);
});
