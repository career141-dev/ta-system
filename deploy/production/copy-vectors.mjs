#!/usr/bin/env node
/**
 * Copy candidate vectors the live index is missing from the old staging index.
 *
 * Adds only. A point already in the live collection is never overwritten, and a
 * point whose candidate does not exist in the live database is skipped — staging
 * held a few candidates of its own, and a vector for someone who is not there
 * would surface in search as a person who cannot be opened.
 *
 *   SRC_KEY=… CONVEX_KEY=… node copy-vectors.mjs            # count only
 *   SRC_KEY=… CONVEX_KEY=… node copy-vectors.mjs --write    # copy
 */

const SRC = process.env.SRC_URL ?? "http://127.0.0.1:6336";
const DST = process.env.DST_URL ?? "http://127.0.0.1:6333";
const CONVEX = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const COLLECTION = "candidate_vectors";
const write = process.argv.includes("--write");

const srcHeaders = { "content-type": "application/json", "api-key": process.env.SRC_KEY ?? "" };
const dstHeaders = { "content-type": "application/json", ...(process.env.DST_KEY ? { "api-key": process.env.DST_KEY } : {}) };

async function post(url, headers, body, method = body === undefined ? "GET" : "POST") {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    if (res.ok) return json;
    if (attempt >= 3) throw new Error(`${url} → HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function existingIds(ids) {
  const r = await post(`${DST}/collections/${COLLECTION}/points`, dstHeaders, { ids, with_payload: false, with_vector: false });
  return new Set(r.result.map((p) => String(p.id)));
}

async function liveCandidates(candidateIds) {
  const found = new Set();
  for (let i = 0; i < candidateIds.length; i += 100) {
    const res = await fetch(`${CONVEX}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Convex ${process.env.CONVEX_KEY}` },
      body: JSON.stringify({ path: "ta/candidates:getBatch", args: { candidateIds: candidateIds.slice(i, i + 100) }, format: "json" }),
    });
    const body = await res.json();
    if (body.status !== "success") throw new Error(`getBatch: ${body.errorMessage}`);
    for (const c of body.value) found.add(String(c._id));
  }
  return found;
}

const before = (await post(`${DST}/collections/${COLLECTION}`, dstHeaders)).result.points_count;
let offset = null, seen = 0, missing = 0, orphans = 0, copied = 0;
for (;;) {
  const page = await post(`${SRC}/collections/${COLLECTION}/points/scroll`, srcHeaders, {
    limit: 256, offset, with_payload: true, with_vector: true,
  });
  const points = page.result.points;
  seen += points.length;
  if (points.length) {
    const have = await existingIds(points.map((p) => p.id));
    const absent = points.filter((p) => !have.has(String(p.id)));
    missing += absent.length;
    if (absent.length) {
      const ids = absent.map((p) => p.payload?.candidateId).filter(Boolean);
      const live = await liveCandidates(ids);
      const keep = absent.filter((p) => live.has(String(p.payload?.candidateId)));
      orphans += absent.length - keep.length;
      if (write && keep.length) {
        await post(`${DST}/collections/${COLLECTION}/points?wait=true`, dstHeaders, {
          points: keep.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
        }, "PUT");
      }
      copied += keep.length;
    }
  }
  if (seen % 5120 < 256) console.log(`  ${seen.toLocaleString()} read · ${missing.toLocaleString()} missing · ${copied.toLocaleString()} ${write ? "copied" : "to copy"}`);
  offset = page.result.next_page_offset;
  if (offset === null || offset === undefined) break;
}
const after = (await post(`${DST}/collections/${COLLECTION}`, dstHeaders)).result.points_count;
console.log(`\nStaging index: ${seen.toLocaleString()} · missing from live: ${missing.toLocaleString()} · candidate not in live DB (skipped): ${orphans.toLocaleString()}`);
console.log(`${write ? "Copied" : "Would copy"}: ${copied.toLocaleString()} · live index ${before.toLocaleString()} → ${after.toLocaleString()}`);
