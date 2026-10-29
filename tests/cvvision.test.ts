import assert from "node:assert/strict";
import test from "node:test";
import { extractText } from "../convex/cvs/cvExtraction";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer;
const enough = "Candidate experience and education with contact details. ".repeat(3);
const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });

test("image CV uses Haiku first and NVIDIA only for thin results", async () => {
  const oldFetch = globalThis.fetch;
  const oldRouter = process.env.OPENROUTER_API_KEY;
  const oldNvidia = process.env.NVIDIA_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  const requests: any[] = [];
  globalThis.fetch = async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    return answer(requests.length === 1 ? "short" : enough);
  };
  try {
    const result = await extractText(png, "application/pdf", false, {} as any);
    assert.equal(result.method, "vision_ocr");
    assert.equal(result.extractionModel, "vision-nvidia");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, "anthropic/claude-haiku-4.5");
    assert.equal(requests[0].messages[0].content[1].type, "image_url");
    assert.equal(requests[1].model, "meta/llama-3.2-11b-vision-instruct");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouter;
    if (oldNvidia === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = oldNvidia;
  }
});

test("invalid PDF bytes never become extracted text", async () => {
  const bytes = new TextEncoder().encode("binary junk ".repeat(20)).buffer;
  const result = await extractText(bytes, "application/pdf");
  assert.equal(result.text, "");
  assert.equal(result.method, "ocr_failed");
});

test("Haiku receives the complete PDF and rejects cut-off answers", async () => {
  const { callHaikuVisionOCR } = await import("../convex/lib/llm");
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  let request: any;
  globalThis.fetch = async (_url: any, init: any) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: enough }, finish_reason: "length" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(await callHaikuVisionOCR({ kind: "pdf", mime: "application/pdf", base64: "JVBERi0=" }), "");
    assert.equal(request.messages[0].content[1].file.file_data, "data:application/pdf;base64,JVBERi0=");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
