import assert from "node:assert/strict";
import test from "node:test";
import {
  e164Phone,
  isOutboundCallTestMode,
  resolveOutboundRecipient,
} from "../livekitSipPolicy";

test("accepts only canonical E.164 phone numbers", () => {
  assert.equal(e164Phone("+94771234567"), "+94771234567");
  assert.equal(e164Phone("  +14155552671  "), "+14155552671");
  assert.equal(e164Phone("0771234567"), null);
  assert.equal(e164Phone("+0123456789"), null);
  assert.equal(e164Phone("+94 77 123 4567"), null);
  assert.equal(e164Phone("+1234567"), null);
});

test("test mode is fail-closed unless both controls explicitly disable it", () => {
  assert.equal(
    isOutboundCallTestMode({
      callTestMode: undefined,
      outreachTestMode: undefined,
      globalTestMode: undefined,
      settingsTestMode: undefined,
    }),
    true,
  );
  assert.equal(
    isOutboundCallTestMode({
      callTestMode: "false",
      outreachTestMode: undefined,
      globalTestMode: undefined,
      settingsTestMode: false,
    }),
    false,
  );
  assert.equal(
    isOutboundCallTestMode({
      callTestMode: "false",
      outreachTestMode: "true",
      globalTestMode: undefined,
      settingsTestMode: false,
    }),
    true,
  );
});

test("test mode never falls back to the candidate phone", () => {
  assert.deepEqual(
    resolveOutboundRecipient({
      isTestMode: true,
      candidatePhone: "+94770000000",
      testRecipient: undefined,
    }),
    { outcome: "suppressed" },
  );
  assert.deepEqual(
    resolveOutboundRecipient({
      isTestMode: true,
      candidatePhone: "+94770000000",
      testRecipient: "+94771111111",
    }),
    { outcome: "dial", recipient: "+94771111111" },
  );
});

test("live mode rejects a non-E.164 candidate number", () => {
  assert.deepEqual(
    resolveOutboundRecipient({
      isTestMode: false,
      candidatePhone: "0771234567",
      testRecipient: "+94771111111",
    }),
    { outcome: "invalid_candidate" },
  );
});
