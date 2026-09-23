/**
 * The inbound WhatsApp webhook's two locks.
 *
 * Until 23 September the four WhatsApp routes ran on anything that reached the
 * URL — no `X-Hub-Signature-256` check at all — and the verification handshake
 * accepted three tokens written into `convex/http.ts`. The callback URL is
 * visible to anyone who can see the app configuration, so a forged POST wrote
 * an inbound message, triggered a DeepSeek reply to a real candidate and
 * patched their application.
 *
 * These tests hold both locks shut, including the three retired literals, so
 * they cannot creep back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { verifyMetaSignature, verifyTokenMatches } from "../convex/lib/webhookSecurity";

const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "900377459288998",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "94742197476", phone_number_id: "965783109962872" },
            messages: [
              { from: "94703205525", id: "wamid.TEST", type: "text", text: { body: "My notice period is 30 days" } },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
});

/** What Meta puts in the header: the raw body signed with the app secret. */
async function sign(secret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  return "sha256=" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("accepts a payload Meta actually signed", async () => {
  assert.equal(await verifyMetaSignature(BODY, await sign(SECRET, BODY), SECRET), true);
});

test("rejects a body changed after signing", async () => {
  const header = await sign(SECRET, BODY);
  const tampered = BODY.replace("30 days", "60 days");
  assert.equal(await verifyMetaSignature(tampered, header, SECRET), false);
});

test("rejects a signature made with a different secret", async () => {
  const header = await sign("ffffffffffffffffffffffffffffffff", BODY);
  assert.equal(await verifyMetaSignature(BODY, header, SECRET), false);
});

test("requires the sha256= prefix Meta sends", async () => {
  const header = await sign(SECRET, BODY);
  const bare = header.slice("sha256=".length);
  assert.equal(await verifyMetaSignature(BODY, bare, SECRET), false);
});

test("rejects malformed, missing and empty-secret cases", async () => {
  const valid = await sign(SECRET, BODY);
  for (const header of [
    null,
    "",
    "sha256=",
    "sha256=nothex".padEnd(71, "z"),
    "sha256=" + "a".repeat(63), // one short
    "sha256=" + "a".repeat(65), // one long
    "sha1=" + valid.slice("sha256=".length),
    valid.toUpperCase(), // "SHA256=" is not the prefix Meta sends
  ]) {
    assert.equal(await verifyMetaSignature(BODY, header, SECRET), false, `accepted ${String(header)}`);
  }
  // No app secret configured: the caller returns 503, and this must never pass.
  assert.equal(await verifyMetaSignature(BODY, valid, ""), false);
});

test("accepts an uppercase-hex signature — the prefix is fixed, the digest is not", async () => {
  const header = await sign(SECRET, BODY);
  const upperHex = "sha256=" + header.slice("sha256=".length).toUpperCase();
  assert.equal(await verifyMetaSignature(BODY, upperHex, SECRET), true);
});

test("the handshake accepts only the configured verify token", () => {
  assert.equal(verifyTokenMatches("the-real-token", "the-real-token"), true);
  assert.equal(verifyTokenMatches("the-real-token", "another-token"), false);
  assert.equal(verifyTokenMatches("the-real", "the-real-token"), false, "prefix must not pass");
  assert.equal(verifyTokenMatches("", "the-real-token"), false);
  assert.equal(verifyTokenMatches(null, "the-real-token"), false);
});

test("the handshake fails closed when no verify token is configured", () => {
  // http.ts returns 503 before reaching this, but the helper must not pass
  // "unset" as a match either — that was the old accept-anything branch.
  assert.equal(verifyTokenMatches("anything", undefined), false);
  assert.equal(verifyTokenMatches("anything", ""), false);
});

test("the three retired hardcoded tokens no longer verify", () => {
  const configured = "a".repeat(64);
  for (const retired of ["career141-secure-key", "whatchimp_secret", "career141"]) {
    assert.equal(verifyTokenMatches(retired, configured), false, `${retired} still passes`);
  }
});
