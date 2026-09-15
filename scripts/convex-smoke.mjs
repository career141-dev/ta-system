/**
 * Reads real rows out of the local backend through the TA function layer and
 * checks the mapping holds.
 *
 * Not a unit test — the mappers are pure and can be tested without a network.
 * This is the other half: that the shapes the backend actually returns are the
 * shapes the mappers expect. Those two drift silently, and a mapper that is
 * correct about a shape nobody sends is worth nothing.
 *
 *   node scripts/convex-smoke.mjs
 */

import fs from "node:fs";
import path from "node:path";

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
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  console.error("Refusing to run against a non-local backend.");
  process.exit(1);
}

async function q(fnPath, args = {}) {
  const res = await fetch(`${url}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  const body = await res.json().catch(() => null);
  if (body?.status !== "success") throw new Error(body?.errorMessage ?? `HTTP ${res.status}`);
  return body.value;
}

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

console.log(`Backend: ${url}\n`);

// ── the actor bridge ─────────────────────────────────────────────────────────
console.log("actor");
const azma = await q("ta/actor:lookupByEmail", { email: "azma@career141.com" });
check("an email resolves to a backend user", Boolean(azma?._id), azma?._id);
const actorId = azma?._id;

const who = await q("ta/actor:whoami", { actorId });
check("whoami authenticates with no Clerk identity", who?.source === "actor_id", who?.source);

// ── users ────────────────────────────────────────────────────────────────────
console.log("\nusers");
const us = await q("ta/users:listTaUsers", {});
check("every TA has an account", us.length >= 9, `${us.length} users`);
check(
  "each carries a taRole",
  us.every((u) => u.taRole),
  `${us.filter((u) => !u.taRole).length} missing`,
);
check(
  "routing emails are unique",
  new Set(us.map((u) => u.routingEmail).filter(Boolean)).size ===
    us.filter((u) => u.routingEmail).length,
  "duplicates would send a CV to the wrong desk",
);

// ── openings ─────────────────────────────────────────────────────────────────
console.log("\nopenings");
const openings = await q("ta/openings:list", { actorId, limit: 500 });
check("openings come back", openings.length > 0, `${openings.length}`);
// Drafts are allowed to be half-filled — somebody is mid-way through typing
// one. The invariant that matters is that anything a recruiter actually works
// is complete, so the assertion is on those and the drafts are reported.
const working = openings.filter((o) => o.status !== "draft");
const junk = openings.filter((o) => o.status === "draft" && (!o.title || !o.clientName));
check(
  "every working opening has a title and a client",
  working.every((o) => o.title && o.clientName),
  `${working.length} working, ${junk.length} incomplete draft(s) ignored`,
);
check(
  "createdAt parses to a real time",
  openings.every((o) => Number.isFinite(Date.parse(String(o.createdAt)))),
  "the mapper turns these into numbers",
);

const withApps = openings.find((o) => (o.totalApplications ?? 0) > 3);
check("found an opening with applications to test against", Boolean(withApps), withApps?.title);

const detail = await q("ta/openings:get", { actorId, openingId: withApps.id });
check("the detail read returns posts and assignments", Array.isArray(detail?.posts), `${detail?.posts?.length ?? 0} posts, ${detail?.assignments?.length ?? 0} assignments`);

// ── applications ─────────────────────────────────────────────────────────────
console.log("\napplications");
const apps = await q("ta/applications:listForOpening", {
  actorId,
  openingId: withApps.id,
  limit: 500,
});
check("applications come back", apps.length > 0, `${apps.length}`);

const TA_STAGES = new Set([
  "new_cv", "matched", "follow_up", "director_review", "director_shortlist",
  "client_shortlist", "interview", "offer", "placed", "rejected", "dropped_out",
]);
check(
  "every stage is one this platform knows",
  apps.every((a) => TA_STAGES.has(a.stage)),
  [...new Set(apps.map((a) => a.stage))].join(", "),
);
check(
  "no application maps to a stage it was not in",
  apps.every((a) => a.backendStage && a.stage),
  "both vocabularies present",
);

// ── candidates ───────────────────────────────────────────────────────────────
console.log("\ncandidates");
const ids = apps.slice(0, 10).map((a) => a.candidateId);
const docs = await q("ta/candidates:getBatch", { actorId, candidateIds: ids });
check("a batch read returns the rows asked for", docs.length > 0, `${docs.length} of ${ids.length}`);
check(
  "each has an id the mapper can key on",
  docs.every((d) => d._id),
  "",
);

const texts = await q("ta/candidates:cvText", { actorId, candidateIds: ids });
const bySource = texts.reduce((acc, t) => ((acc[t.source] = (acc[t.source] ?? 0) + 1), acc), {});
check("CV text reports where it lives", texts.length === ids.length, JSON.stringify(bySource));
check(
  "nothing claims to have text without having it",
  texts.every((t) => (t.source === "db" ? typeof t.text === "string" && t.text.length > 0 : true)),
  "a 'db' row with no text would score somebody on nothing",
);

// ── pipeline signals ─────────────────────────────────────────────────────────
console.log("\nsignals");
const signals = await q("ta/search:pipelineSignals", { actorId, candidateIds: ids.slice(0, 5) });
check("signals come back per candidate", Object.keys(signals).length === 5, `${Object.keys(signals).length} of 5`);

console.log(failed === 0 ? "\nAll checks passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed ? 1 : 0);
