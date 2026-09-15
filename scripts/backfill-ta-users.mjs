/**
 * Give the TA platform's people accounts in the Convex backend.
 *
 * The two rosters were populated separately, so most TAs have no account in
 * the backend and `resolveActor` can find nobody to act as for them. This
 * reads the TA platform's own roster and upserts it, matching on email.
 *
 * Dry run by default — it prints what it would do and writes nothing. Pass
 * `--write` to commit.
 *
 *   node scripts/backfill-ta-users.mjs                      # dry run
 *   node scripts/backfill-ta-users.mjs --write              # commit
 *   node scripts/backfill-ta-users.mjs --db ../../.data/db.json
 *
 * Idempotent: running it twice reports everything as unchanged the second
 * time. Existing backend users keep their role and their Clerk token; they
 * only gain routingEmail, initials and taRole.
 */

import fs from "node:fs";
import path from "node:path";

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const write = flag("write");
const dbPath = path.resolve(process.cwd(), value("db", ".data/db.json"));

// ── the TA roster ────────────────────────────────────────────────────────────
if (!fs.existsSync(dbPath)) {
  console.error(
    `No TA database at ${dbPath}.\n` +
      `Point --db at the platform's db.json (the main checkout keeps one at .data/db.json).`,
  );
  process.exit(1);
}

// utf-8 explicitly: the seed carries names with accents, and reading it as the
// system codepage fails outright on Windows.
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const roster = (db.users ?? [])
  .filter((u) => u.isActive !== false)
  .map((u) => ({
    email: String(u.email ?? "").trim().toLowerCase(),
    fullName: String(u.name ?? u.fullName ?? "").trim(),
    taRole: String(u.role ?? "ta"),
    routingEmail: u.routingEmail ?? null,
    initials: u.initials ?? undefined,
    isActive: u.isActive !== false,
  }))
  .filter((u) => u.email && u.fullName);

if (roster.length === 0) {
  console.error(`No usable users in ${dbPath}.`);
  process.exit(1);
}

// ── the backend ──────────────────────────────────────────────────────────────
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
  } catch {
    /* absent is fine */
  }
  return out;
}

const env = { ...readEnv(".env.local"), ...process.env };
const url = (env.CONVEX_SELF_HOSTED_URL || env.CONVEX_URL || "").replace(/\/+$/, "");
const adminKey = env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "";

if (!url || !adminKey) {
  console.error("Set CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY in .env.local.");
  process.exit(1);
}
// The same refusal the CLI wrapper makes. A backfill aimed at production
// would create accounts in the live system.
const host = new URL(url).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to write to ${host}: this script is local-only.`);
  process.exit(1);
}

async function call(kind, fnPath, args) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== "success") {
    throw new Error(body?.errorMessage ?? `HTTP ${res.status}`);
  }
  return body.value;
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log(`TA roster:  ${roster.length} users from ${dbPath}`);
console.log(`Backend:    ${url}`);
console.log(`Mode:       ${write ? "WRITE" : "dry run (pass --write to commit)"}\n`);

const result = await call("mutation", "ta/users:upsertTaUsers", {
  users: roster,
  dryRun: !write,
});

const pad = (s, n) => String(s).padEnd(n);
for (const r of result.results) {
  const mark = { created: "+", updated: "~", unchanged: "=" }[r.action];
  console.log(`  ${mark} ${pad(r.email, 34)} ${pad(r.action, 10)} ${r.note ?? ""}`);
}

console.log(
  `\n${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged.`,
);
if (!write) console.log("Nothing was written. Re-run with --write to commit.");
