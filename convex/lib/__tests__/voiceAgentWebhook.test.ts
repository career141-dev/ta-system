import assert from "node:assert/strict";
import test from "node:test";
import {
  isFreshVoiceAgentTimestamp,
  parseVoiceAgentEvent,
  verifyVoiceAgentSignature,
} from "../voiceAgentWebhook";

async function signature(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${nonce}.${rawBody}`),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("verifies the exact timestamp.nonce.rawBody HMAC contract", async () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const timestamp = "1720000000000";
  const nonce = "nonce_0123456789abcdef";
  const rawBody = '{"type":"consent"}';
  const valid = await signature(secret, timestamp, nonce, rawBody);

  assert.equal(
    await verifyVoiceAgentSignature({
      rawBody,
      timestamp,
      nonce,
      signature: valid,
      secret,
    }),
    true,
  );
  assert.equal(
    await verifyVoiceAgentSignature({
      rawBody: `${rawBody} `,
      timestamp,
      nonce,
      signature: valid,
      secret,
    }),
    false,
  );
});

test("enforces a five-minute timestamp window", () => {
  const now = 1_720_000_000_000;
  assert.equal(isFreshVoiceAgentTimestamp(String(now), now), true);
  assert.equal(isFreshVoiceAgentTimestamp(String(now - 300_001), now), false);
  assert.equal(isFreshVoiceAgentTimestamp("not-a-time", now), false);
});

test("validates salary currency and notice-period currency isolation", () => {
  assert.deepEqual(
    parseVoiceAgentEvent({
      type: "confirmed_answer",
      callSessionId: "session_123",
      turnId: "turn_1",
      field: "currentSalary",
      value: 100_000,
      currency: "LKR",
      expectedStateVersion: 1,
    }),
    {
      type: "confirmed_answer",
      callSessionId: "session_123",
      turnId: "turn_1",
      field: "currentSalary",
      value: 100_000,
      currency: "LKR",
      expectedStateVersion: 1,
    },
  );
  assert.throws(() =>
    parseVoiceAgentEvent({
      type: "confirmed_answer",
      callSessionId: "session_123",
      turnId: "turn_1",
      field: "expectedSalary",
      value: 120_000,
      expectedStateVersion: 1,
    }),
  );
  assert.throws(() =>
    parseVoiceAgentEvent({
      type: "confirmed_answer",
      callSessionId: "session_123",
      turnId: "turn_2",
      field: "noticePeriodDays",
      value: 30,
      currency: "LKR",
      expectedStateVersion: 1,
    }),
  );
});

test("rejects unsupported fields", () => {
  assert.throws(() =>
    parseVoiceAgentEvent({
      type: "consent",
      callSessionId: "session_123",
      decision: "granted",
      idempotencyKey: "consent_123456789",
      expectedStateVersion: 0,
      candidateId: "client-controlled",
    }),
  );
});
