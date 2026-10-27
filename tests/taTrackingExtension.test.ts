import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as core from "../career141-browser-tracker/core.js";

let clock = Date.now();
let listener: any;
let offline = false;
const storage: Record<string, any> = {};
const uploads: any[] = [];
let authCount = 0;
let invalidSession = false;
let missingTaTab = false;
let testTaOrigin = 'http://localhost:3100';
const startupListeners: (() => void)[] = [];
const event = () => ({ addListener() {} });
const chrome = {
  storage: { local: { async get(key: string) { return structuredClone({ [key]: storage[key] }); }, async set(data: any) { Object.assign(storage, structuredClone(data)); } } },
  tabs: { async query(query: any) { return query.url ? missingTaTab ? [] : [{ id: 20, url: `${testTaOrigin}/ta-track`, incognito: false }] : [{ id: 10, url: "https://web.whatsapp.com/", incognito: false }]; }, onActivated: event(), onUpdated: event(), onRemoved: event() },
  windows: { async getAll() { return [{ id: 1, focused: true, incognito: false }]; }, onFocusChanged: event() },
  idle: { async queryState() { return "active"; }, async setDetectionInterval() {}, onStateChanged: event() },
  alarms: { onAlarm: event(), async create() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, onInstalled: event(), onStartup: { addListener(fn: () => void) { startupListeners.push(fn); } }, onMessage: { addListener(fn: any) { listener = fn; } } },
  scripting: {
    async executeScript({ target, args, func }: any) {
      ++authCount;
      assert.equal(target.tabId, 20, 'verification runs only in a matching TA website tab');
      assert.equal(args[0].email, 'ta@career141.com');
      assert.match(args[0].tokenHash, /^[a-f0-9]{64}$/);
      assert.equal('token' in args[0], false, 'private credential never enters the website tab');
      const result = await vm.runInNewContext(`(${func.toString()})(request)`, {
        request: args[0], AbortSignal,
        fetch: async (path: string, options: any) => {
          assert.equal(path, '/api/ta-track');
          assert.equal(options.method, 'POST');
          assert.equal(options.credentials, 'same-origin');
          assert.deepEqual(JSON.parse(options.body), JSON.parse(JSON.stringify(args[0])));
          return { ok: !invalidSession, async json() { return invalidSession ? { error: 'Sign in with the matching email.' } : { ok: true }; } };
        },
      });
      return [{ result }];
    },
  },
};
const context = { ...core, chrome, console, URL, URLSearchParams, TextEncoder, Uint8Array, btoa, crypto: webcrypto, AbortSignal, Date: class extends Date { static now() { return clock; } },
  fetch: async (url: string, init: any) => {
    uploads.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (offline) throw new Error("offline");
    return { ok: true, async json() { return { ok: true, name: "Verified TA", email: "ta@career141.com" }; } };
  },
};
const source = readFileSync(new URL("../career141-browser-tracker/background.js", import.meta.url), "utf8").replace(/^import .*?;\s*/, "");
vm.runInNewContext(source, context);
const popup = { url: "chrome-extension://test/popup.html" };
const website = { url: "https://web.whatsapp.com/", tab: { id: 10, incognito: false } };
const send = (message: any, sender = popup): Promise<any> => new Promise(resolve => {
  if (!listener(message, sender, resolve)) resolve({ rejected: true });
});
assert.equal((await send({ type: "sign-in" }, website)).rejected, true, "websites cannot sign in accounts");
storage.tracker = { ...core.newState(), enabled: true, name: 'Gajani', consent: true, rows: { legacy: { lastSeen: clock, clicks: 7 } } };
const upgraded = await send({ type: "status" });
assert.equal(upgraded.state.enabled, false, "legacy ON state is paused so email sign-in is unlocked");
assert.equal(upgraded.state.consent, false, "email sign-in requires fresh consent");
assert.equal(upgraded.state.rows.legacy.clicks, 7, "upgrade preserves previously collected data");
assert.equal((await send({ type: "start", consent: true })).ok, false, "unpaired collection is blocked");
const signIn = { type: "sign-in", origin: "http://localhost:3100", email: "ta@career141.com", consent: true };
assert.equal((await send({ ...signIn, origin: "http://external.example" })).ok, false, "remote HTTP refused");
assert.equal((await send({ ...signIn, consent: false })).ok, false);
assert.equal((await send({ ...signIn, email: "fake@example.com" })).ok, false);
missingTaTab = true;
assert.equal((await send(signIn)).ok, false, 'missing signed-in TA tab reports an error without opening a window');
missingTaTab = false;
invalidSession = true;
assert.equal((await send(signIn)).ok, false, "a different or signed-out account cannot start tracking");
assert.equal("pairing" in storage, false);
invalidSession = false;
assert.equal((await send(signIn)).ok, true);
assert.equal(storage.tracker.enabled, true, "tracking starts after verified email sign-in");
assert.equal(storage.pairing.email, "ta@career141.com");
assert.equal(storage.tracker.name, "Verified TA");
assert.equal((await send({ type: "start", consent: false })).ok, false);
assert.equal((await send({ type: "start", consent: true, name: "Forged TA" })).ok, true);
assert.equal(storage.tracker.name, "Verified TA", "labels cannot override the paired account");
clock += 16000;
await send({ type: "activity", clicks: 4, scrolls: 2, movementSeconds: 3 }, website);
clock += 16000;
await send({ type: "status" });
assert.equal(uploads.at(-1).body.rows[0].clicks, 4);
assert.equal("name" in uploads.at(-1).body.rows[0], false, "upload omits local identity labels");
assert.equal(uploads.at(-1).url, "http://localhost:3100/api/ta-track/upload");
clock += 31000; offline = true;
await send({ type: "activity", clicks: 2, scrolls: 0, movementSeconds: 1 }, website);
assert.equal(storage.pairing.error, "offline");
assert.equal(Object.values(storage.tracker.rows).some((r: any) => r.clicks === 6), true, "offline data retained");
clock += 31000; offline = false;
await send({ type: "status" });
assert.equal(uploads.at(-1).body.rows[0].clicks, 6, "retry sends cumulative counts");
assert.equal(storage.pairing.error, "");
assert.equal((await send({ type: "pause" })).ok, true);
assert.equal(uploads.at(-1).body.enabled, false);
const previousAuthCount = authCount;
assert.equal((await send(signIn)).ok, true);
assert.equal(authCount, previousAuthCount, "resuming the same account does not require another sign-in");
assert.equal((await send({ type: "clear" }, website)).rejected, true);
assert.equal((await send({ type: "status" }, { url: "chrome-extension://test/report.html" })).rejected, true);
await send({ type: 'pause' });
testTaOrigin = 'https://aura.career141.com';
assert.equal((await send({ ...signIn, origin: 'https://ta-system.career141.com' })).ok, true, 'a signed-in Aura tab works when the extension defaults to the TA System alias');
assert.equal(storage.pairing.origin, 'https://aura.career141.com');
assert.equal(uploads.at(-1).url, 'https://aura.career141.com/api/ta-track/upload');
await send({ type: 'pause' });
delete storage.pairing;
testTaOrigin = 'https://ta-system.career141.com';
assert.equal((await send({ ...signIn, origin: 'https://aura.career141.com' })).ok, true, 'alias fallback works in the reverse direction');
assert.equal(storage.pairing.origin, 'https://ta-system.career141.com');
await send({ type: 'pause' });
const totalTime = () => Object.values(storage.tracker.rows).reduce((sum: number, row: any) => sum + row.foregroundMs, 0);
const beforeWeekend = totalTime();
clock += 3 * 86400000;
for (const start of startupListeners) start();
await send({ type: 'status' });
assert.equal(storage.tracker.enabled, false, 'Friday Pause remains paused after a weekend/browser restart');
assert.equal(totalTime(), beforeWeekend, 'paused weekend receives no website time');
await send({ ...signIn, origin: testTaOrigin });
const beforeClose = totalTime();
clock += 600000;
for (const start of startupListeners) start();
await send({ type: 'status' });
assert.equal(storage.tracker.enabled, true, 'closing without Pause resumes tracking on browser restart');
assert.equal(totalTime(), beforeClose, 'time while the browser was closed is not credited');
for (const activeUrl of ['http://localhost:3100/ta-track', 'https://aura.career141.com/', 'https://ta-system.career141.com/clients']) {
  const popupNodes: Record<string, any> = {};
  const popupNode = (id: string) => popupNodes[id] ??= { value: id === 'origin' ? 'https://ta-system.career141.com' : '' };
  vm.runInNewContext(readFileSync(new URL('../career141-browser-tracker/popup.js', import.meta.url), 'utf8'), {
  URL,
  document: { getElementById: popupNode },
  chrome: {
    runtime: { async sendMessage() { return { ok: true, state: { enabled: true, name: 'Gajani', consent: true } }; } },
    storage: { local: { async get() { return {}; } } },
    tabs: { async query() { return [{ url: activeUrl }]; } },
  },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(popupNodes.email.disabled, false, 'email stays editable for an unsigned legacy tracker');
assert.equal(popupNodes.start.disabled, false);
assert.equal(popupNodes.status.textContent, 'Sign in to start tracking');
assert.equal(popupNodes.origin.value, new URL(activeUrl).origin, 'the popup selects the current TA website');
assert.equal(popupNodes.destination.textContent, `Reports go to: ${new URL(activeUrl).origin}`);
}
console.log("TA tracker extension: upgrade recovery, editable email, destination selection, sign-in, activity upload, offline retry and pause passed.");
