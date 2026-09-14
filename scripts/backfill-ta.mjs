/**
 * Fit the restored production data to the new shape.
 *
 * Dry run by default — it reports exactly what it would change and writes
 * nothing. Pass `--write` to commit.
 *
 *   node scripts/backfill-ta.mjs            # rehearse
 *   node scripts/backfill-ta.mjs --write    # commit
 *   node scripts/backfill-ta.mjs --status   # just look
 *
 * Idempotent: a second run reports nothing left to do. Nothing here overwrites
 * a value somebody set, so a correction made by hand survives a re-run.
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const statusOnly = argv.includes("--status");

function readEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.resolve(process.cwd(), file), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

const env = { ...readEnv(".env.local"), ...process.env };
const url = (env.CONVEX_SELF_HOSTED_URL || env.CONVEX_URL || "").replace(/\/+$/, "");
const adminKey = env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "";
if (!url || !adminKey) {
  console.error("Set CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY in .env.local.");
  process.exit(1);
}
// A backfill aimed at production would rewrite the live system.
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  console.error(`Refusing to write to ${new URL(url).hostname}: this script is local-only.`);
  process.exit(1);
}

async function call(kind, fnPath, args = {}) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  const body = await res.json().catch(() => null);
  if (body?.status !== "success") throw new Error(body?.errorMessage ?? `HTTP ${res.status}`);
  return body.value;
}

const n = (x) => Number(x).toLocaleString();

async function showStatus(label) {
  // The status query pages: Convex allows one paginated query per execution,
  // so the loop is here.
  let cursor = null, jobs = { total: 0, withClientId: 0, withJdStatus: 0, withPriorityTier: 0 };
  let clients = 0, posts = 0, covered = 0, pages = 0;
  for (;;) {
    const s = await call("query", "ta/backfill:status", { cursor });
    for (const k of Object.keys(jobs)) jobs[k] += s.jobs[k];
    if (pages === 0) {
      clients = s.clients.total;
      posts = s.jobPosts.total;
      covered = s.jobPosts.openingsCovered;
    }
    pages++;
    if (s.isDone || !s.continueCursor || pages > 200) break;
    cursor = s.continueCursor;
  }
  console.log(`
${label}`);
  console.log(`  jobs            ${n(jobs.total)}  · client linked ${n(jobs.withClientId)} · jd status ${n(jobs.withJdStatus)} · tier ${n(jobs.withPriorityTier)}`);
  console.log(`  clients         ${n(clients)}`);
  console.log(`  job posts       ${n(posts)}  · openings covered ${n(covered)}`);
}

console.log(`Backend: ${url}`);
console.log(`Mode:    ${statusOnly ? "status only" : write ? "WRITE" : "dry run (pass --write to commit)"}`);

await showStatus("Before");
if (statusOnly) process.exit(0);

const dryRun = !write;

/**
 * Run a paged step to the end.
 *
 * Every step pages, because a job row carries its whole description and an
 * inline reverseMatchResults array — reading even 95 at once exceeds what one
 * Convex execution may read. A dry run pages the same way so the rehearsal
 * covers the same rows the real run will.
 */
async function runPaged(label, fn, sum) {
  let cursor = null, pages = 0;
  const totals = {};
  for (;;) {
    const r = await call("mutation", fn, { dryRun, cursor });
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
      else if (Array.isArray(v)) totals[k] = [...(totals[k] ?? []), ...v];
    }
    pages++;
    if (r.isDone || !r.continueCursor || pages > 200) break;
    cursor = r.continueCursor;
  }
  console.log(`
${label}`);
  console.log("  " + sum(totals));
  return totals;
}

const clients = await runPaged(
  "clients",
  "ta/backfill:backfillClients",
  (t) =>
    `${new Set(t.createdKeys ?? []).size} created, ${t.linked ?? 0} job(s) linked, ` +
    `${t.alreadyLinked ?? 0} already linked`,
);
// One client can appear on several pages, so the spellings are unioned by key
// before being shown.
const foldedByKey = new Map();
for (const f of clients.folded ?? []) {
  foldedByKey.set(f.key, new Set([...(foldedByKey.get(f.key) ?? []), ...f.spellings]));
}
for (const [, set] of foldedByKey) {
  if (set.size > 1) console.log(`    folded: ${[...set].join("  /  ")}`);
}

await runPaged(
  "job posts",
  "ta/backfill:backfillJobPosts",
  (t) => `${t.created ?? 0} created, ${t.skipped ?? 0} already present`,
);

await runPaged(
  "job fields",
  "ta/backfill:backfillJobFields",
  (t) => `${t.patched ?? 0} patched, ${t.untouched ?? 0} already complete`,
);

await runPaged(
  "applications",
  "ta/backfill:backfillApplications",
  (t) => `${n(t.patched ?? 0)} patched, ${n(t.untouched ?? 0)} already complete`,
);

await showStatus("After");
if (dryRun) console.log("\nNothing was written. Re-run with --write to commit.\n");
else console.log("\nDone.\n");
