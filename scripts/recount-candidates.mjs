#!/usr/bin/env node
/**
 * scripts/recount-candidates.mjs
 *
 * Counts the candidates table exactly and sets the backend's candidate counter
 * (systemStats.totalCandidates) to that number — what the Database pages show.
 *
 * Run after importing a snapshot: an import writes rows directly and bypasses
 * the counter that ingestion keeps, which is how staging came to read 47,488
 * against 77,216 real rows.
 *
 *   CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=… \
 *     node scripts/recount-candidates.mjs
 *
 * Loopback only, like the other Convex scripts here. For the server, open an
 * SSH tunnel to its Convex port first.
 */

const url = process.env.CONVEX_SELF_HOSTED_URL ?? "";
const key = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
  console.error(`Refusing: CONVEX_SELF_HOSTED_URL must be a loopback address (got "${url}").`);
  process.exit(1);
}
if (!key) {
  console.error("CONVEX_SELF_HOSTED_ADMIN_KEY is not set.");
  process.exit(1);
}

async function call(kind, path, args) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${key}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await res.json().catch(() => null);
  if (body?.status !== "success") throw new Error(body?.errorMessage ?? `HTTP ${res.status}`);
  return body.value;
}

let cursor = null;
let total = 0;
let pages = 0;
let size = 1000;
const started = Date.now();
for (;;) {
  let page;
  try {
    page = await call("query", "ta/candidates:countPage", { cursor, numItems: size });
  } catch (e) {
    // A page past the backend's one-second limit is asked for again, smaller.
    if (/timed out/i.test(e.message) && size > 50) {
      size = Math.floor(size / 2);
      continue;
    }
    throw e;
  }
  total += page.n;
  pages++;
  if (pages % 10 === 0) process.stdout.write(`  ${total.toLocaleString()} counted…\n`);
  if (page.isDone) break;
  cursor = page.continueCursor;
}

await call("mutation", "ta/candidates:setCandidateTotal", { total });
console.log(`${total.toLocaleString()} candidates (${pages} pages, ${Math.round((Date.now() - started) / 1000)}s). Counter set.`);
