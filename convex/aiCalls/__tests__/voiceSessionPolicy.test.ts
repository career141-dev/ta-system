import assert from "node:assert/strict";
import test from "node:test";
import {
  isProductionVoiceMode,
  productionWritePolicy,
} from "../voiceSessionPolicy";

test("test and simulation sessions cannot enter production write paths", () => {
  assert.equal(isProductionVoiceMode("simulation"), false);
  assert.equal(isProductionVoiceMode("test"), false);
  assert.equal(isProductionVoiceMode("live"), true);
});

test("test mode has zero production candidate/application/event/outcome writes", () => {
  assert.deepEqual(productionWritePolicy("test"), {
    candidateFields: false,
    applicationFields: false,
    pipelineEvents: false,
    productionAiCallOutcome: false,
  });
});
