import assert from "node:assert/strict";
import test from "node:test";
import { Breaker, Gate, ReadCache, backoffMs, failureCategory } from "../src/lib/convexResilience";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("two identical reads at once make one request", async () => {
  const cache = new ReadCache();
  let calls = 0;
  const load = async () => { calls++; await tick(); return "rows"; };
  const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  // Not kept: the next read asks again.
  await cache.get("k", load);
  assert.equal(calls, 2);
});

test("callers cannot change each other's rows", async () => {
  const cache = new ReadCache();
  const load = async () => { await tick(); return { rows: [1, 2] }; };
  const [a, b] = await Promise.all([cache.get("k", load, 1000), cache.get("k", load, 1000)]);
  a.rows.push(3);
  assert.deepEqual(b.rows, [1, 2]);
  assert.deepEqual((await cache.get("k", load, 1000)).rows, [1, 2]);
});

test("a read that failed is not shared with the next one", async () => {
  const cache = new ReadCache();
  await assert.rejects(cache.get("k", async () => { throw new Error("down"); }));
  assert.equal(await cache.get("k", async () => "back"), "back");
});

test("a kept read lasts its lifetime, and a write drops it", async () => {
  let now = 0;
  const cache = new ReadCache(() => now);
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await cache.get("k", load, 1000), 1);
  now = 999;
  assert.equal(await cache.get("k", load, 1000), 1);
  now = 1000;
  assert.equal(await cache.get("k", load, 1000), 2);
  cache.clear();
  assert.equal(await cache.get("k", load, 1000), 3);
});

test("a read that was out when a write landed is not kept", async () => {
  const cache = new ReadCache();
  let calls = 0;
  const slow = async () => { const n = ++calls; await tick(); return n; };
  const p = cache.get("k", slow, 1000);
  cache.clear();
  await p;
  assert.equal(await cache.get("k", slow, 1000), 2);
});

test("the gate never runs more than its limit, and serves everyone", async () => {
  const gate = new Gate(2);
  let active = 0;
  let peak = 0;
  const work = async () => { active++; peak = Math.max(peak, active); await tick(); active--; };
  await Promise.all(Array.from({ length: 10 }, () => gate.run(work)));
  assert.equal(peak, 2);
  // A failing call gives its place back.
  await assert.rejects(gate.run(async () => { throw new Error("x"); }));
  assert.equal(await gate.run(async () => "ok"), "ok");
});

test("the breaker opens after repeated failures, lets one through when cooled, closes on success", () => {
  let now = 0;
  const b = new Breaker(() => now, 3, 5000);
  b.failure(); b.failure();
  assert.equal(b.blockedFor(), 0);
  b.failure();
  assert.equal(b.blockedFor(), 5);
  now = 4000;
  assert.equal(b.blockedFor(), 1);
  now = 5000;
  assert.equal(b.blockedFor(), 0); // the probe
  assert.equal(b.blockedFor(), 5); // others wait while it runs
  b.success();
  assert.equal(b.blockedFor(), 0);
});

test("backoff doubles to a ceiling and stays within a quarter either side", () => {
  assert.equal(backoffMs(1, () => 0.5), 300);
  assert.equal(backoffMs(2, () => 0.5), 600);
  assert.equal(backoffMs(9, () => 0.5), 2000);
  assert.equal(backoffMs(1, () => 0), 225);
  assert.equal(backoffMs(1, () => 1), 375);
});

test("a function over its execution budget is not retried; a gateway hiccup is", () => {
  assert.equal(failureCategory("Convex refused candidates/candidates:getCvUploadUrl: [Request ID: x] Server Error\nFunction execution timed out (maximum duration: 1s)", false, 500), "budget");
  assert.equal(failureCategory("Convex refused x: Too many bytes read in a single function execution", false, 500), "budget");
  assert.equal(failureCategory("Convex refused x: HTTP 503", false, 503), "transient");
  assert.equal(failureCategory("Could not reach the Convex backend (fetch failed).", true), "unreachable");
  assert.equal(failureCategory("Convex refused x: Uncaught Error: Start today's workday first.", false, 400), "refused");
  assert.equal(failureCategory("The backend did not answer x within 30 seconds."), "other");
});
