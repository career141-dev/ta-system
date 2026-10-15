import assert from "node:assert/strict";
import { saveConfirmedResearchLink, type ResearchLinkState } from "../src/lib/chatgptResearchSync";

const url = "https://chatgpt.com/share/12345678";
const states: ResearchLinkState[] = [];
let calls = 0;
let release: ((result: {ok: boolean; message: string}) => void) | undefined;
const saving = saveConfirmedResearchLink("synthetic-job", `${url}/?utm_source=test`, async form => {
  calls++;
  assert.equal(form.get("jobId"), "synthetic-job");
  assert.equal(form.get("link"), url);
  assert.equal(form.get("confirmed"), "on");
  assert.equal(form.get("op"), "saveCheck");
  assert.equal(form.get("kind"), "chatgpt");
  return await new Promise(resolve => { release = resolve; });
}, state => states.push(state));
assert.equal(states[0].saving, true);
assert.equal(states[0].confirmed, false, "Checking the box cannot confer confirmation before persistence");
release!({ ok: true, message: "Saved." });
assert.equal(await saving, true);
assert.equal(states.at(-1)!.link, url);
assert.equal(states.at(-1)!.confirmed, true);
assert.equal(states.at(-1)!.saving, false);
assert.equal(calls, 1, "One confirmation performs one shared save");

let invalidSaves = 0;
for (const link of ["", "https://chatgpt.com/c/private-link", "https://example.invalid/share/12345678"]) {
  assert.equal(await saveConfirmedResearchLink("synthetic-job", link, async () => { invalidSaves++; return { ok: true, message: "Unexpected save" }; }, state => states.push(state)), false);
  assert.equal(states.at(-1)!.confirmed, false);
}
assert.equal(invalidSaves, 0, "Invalid and private links are rejected before a request is made");
assert.equal(await saveConfirmedResearchLink("synthetic-job", url, async () => ({ ok: false, message: "Start your workday first." }), state => states.push(state)), false);
assert.equal(states.at(-1)!.message, "Start your workday first.");
assert.equal(states.at(-1)!.confirmed, false);
assert.equal(states.at(-1)!.link, url, "A failed save preserves the typed link for retry");
assert.equal(await saveConfirmedResearchLink("synthetic-job", url, async () => { throw new Error("Network failure"); }, state => states.push(state)), false);
assert.equal(states.at(-1)!.saving, false);
assert.equal(states.at(-1)!.confirmed, false);
console.log("Shared ChatGPT confirmation saves once, normalizes URLs, waits for persistence, and preserves drafts on failure.");
