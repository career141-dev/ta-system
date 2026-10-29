import assert from "node:assert/strict";
import test from "node:test";
import { extractText } from "../convex/cvs/cvExtraction";
import { callHaikuVisionOCR } from "../convex/lib/llm";
import { askCvVision, readCvVisionRequest } from "../src/lib/claudeCvVision";
import { bridgeSecretOk } from "../src/lib/claudeBridge";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer;
const enough = "Candidate experience and education with contact details. ".repeat(3);
const file = { kind: "pdf" as const, mime: "application/pdf", base64: Buffer.from("%PDF-abc").toString("base64") };
const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });

test("thin image tries subscription bridge before NVIDIA", async () => {
  const oldFetch = globalThis.fetch, oldBase = process.env.C141_APP_INTERNAL_URL, oldSecret = process.env.C141_CLAUDE_BRIDGE_SECRET, oldNvidia = process.env.NVIDIA_API_KEY;
  process.env.C141_APP_INTERNAL_URL = "http://example.invalid";
  process.env.C141_CLAUDE_BRIDGE_SECRET = "synthetic-secret-12345";
  process.env.NVIDIA_API_KEY = "synthetic-nvidia-key";
  const requests: any[] = [];
  globalThis.fetch = async (url: any, init: any) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return requests.length === 1 ? new Response(JSON.stringify({ ok: true, text: "short" }), { status: 200 }) : answer(enough); };
  try {
    const result = await extractText(png, "application/pdf", false, {} as any);
    assert.equal(result.extractionModel, "vision-nvidia");
    assert.match(requests[0].url, /claude-cv-vision/);
    assert.equal(requests[0].body.mime, "image/png");
    assert.equal(requests[1].body.model, "meta/llama-3.2-11b-vision-instruct");
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ C141_APP_INTERNAL_URL: oldBase, C141_CLAUDE_BRIDGE_SECRET: oldSecret, NVIDIA_API_KEY: oldNvidia })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("bridge validates document bytes, credentials and size", async () => {
  assert.deepEqual(readCvVisionRequest(file), file);
  assert.equal(readCvVisionRequest({ ...file, mime: "image/png", kind: "image" }), null);
  assert.equal(readCvVisionRequest({ ...file, base64: "not base64" }), null);
  assert.equal(readCvVisionRequest({ ...file, base64: "A".repeat(12_000_000) }), null);
  assert.equal(bridgeSecretOk("wrong-secret"), false);
});

test("subscription CLI receives the PDF with Haiku and rejects truncated output", async () => {
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "synthetic-token";
  let argv: string[] = [], input = "";
  const run = async (args: string[], prompt: string) => { argv = args; input = prompt; return { code: 0, out: JSON.stringify({ type: "assistant", message: { stop_reason: "max_tokens" } }) + "\n" + JSON.stringify({ type: "result", subtype: "success", result: enough }), err: "", timedOut: false }; };
  try {
    assert.equal(await askCvVision(file, run), null);
    assert.ok(argv.includes("claude-haiku-4-5-20251001"));
    assert.ok(argv.includes("--input-format"));
    const document = JSON.parse(input).message.content[1];
    assert.equal(document.type, "document");
    assert.equal(document.source.data, file.base64);
    const success = async () => ({ code: 0, out: JSON.stringify({ type: "result", subtype: "success", result: enough }), err: "", timedOut: false });
    assert.equal(await askCvVision(file, success), enough.trim());
    const failed = async () => ({ code: 1, out: "", err: "unavailable", timedOut: false });
    assert.equal(await askCvVision(file, failed), null);
  } finally { if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken; }
});

test("missing bridge and invalid PDF fail closed", async () => {
  const base = process.env.C141_APP_INTERNAL_URL;
  delete process.env.C141_APP_INTERNAL_URL;
  try { assert.equal(await callHaikuVisionOCR(file), ""); } finally { if (base !== undefined) process.env.C141_APP_INTERNAL_URL = base; }
  const result = await extractText(new TextEncoder().encode("binary junk ".repeat(20)).buffer, "application/pdf");
  assert.equal(result.text, "");
});
