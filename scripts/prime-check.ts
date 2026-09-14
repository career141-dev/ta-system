/**
 * Read the real database through `repo`, with the store backed by Convex.
 *
 * This is the check that matters for the primed-snapshot design: that a page
 * can await once and then use the synchronous `repo` exactly as written, and
 * that the rows it gets back are the production ones rather than the seed.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/prime-check.ts
 *
 * The `react-server` condition is what lets `server-only` resolve to its no-op
 * build; without it that package throws outside a bundler.
 */

import fs from "node:fs";
import path from "node:path";

// Next loads .env.local for the app; a bare Node script has to do it itself,
// and the store reads its target and key straight out of the environment.
for (const line of fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const key = t.slice(0, eq).trim();
  if (!(key in process.env)) process.env[key] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}

process.env.C141_STORE = "convex";

import { repo } from "@/data/store";
import { primeStore, resetStore } from "@/data/prime";

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

console.log("store mode: convex\n");

// ── unprimed reads must fail loudly, not quietly return nothing ──────────────
console.log("the guard");
resetStore();
let threw = "";
try {
  repo.users();
} catch (e) {
  threw = (e as Error).message;
}
check("an unprimed read says what to do", threw.includes("primeStore"), threw.slice(0, 60) + "…");

// ── the desk-wide scope ──────────────────────────────────────────────────────
console.log("\ndesk-wide");
await primeStore({ allApplications: true });

const users = repo.users();
check("users come back", users.length >= 9, `${users.length}`);
check("each has a role this platform knows", users.every((u) => u.role), "");

const openings = repo.openings();
check("openings come back", openings.length > 50, `${openings.length}`);
check(
  "every opening has a title",
  openings.filter((o) => o.status !== "closed").every((o) => o.title),
  "",
);

const clients = repo.clients();
check("clients are derived and folded by name", clients.length > 0, `${clients.length} distinct`);
check(
  "no two clients share a normalised name",
  new Set(clients.map((c) => c.name.toLowerCase().replace(/[^a-z0-9]+/g, ""))).size === clients.length,
  "DirectFN and DIRECTFN must be one",
);

const apps = repo.applications();
check("applications come back", apps.length > 100, `${apps.length}`);
check(
  "every application maps to a stage this platform knows",
  apps.every((a) => a.stage),
  [...new Set(apps.map((a) => a.stage))].join(", "),
);

// ── an opening, worked the way a page works it ───────────────────────────────
console.log("\none opening, read synchronously");
const busy = openings
  .map((o) => ({ o, n: repo.applications(o.id).length }))
  .sort((a, b) => b.n - a.n)[0];
check("found an opening with applications", busy.n > 0, `${busy.o.title} (${busy.n})`);

// The point of the whole design: no await below this line.
const rows = repo.applications(busy.o.id);
const people = rows.map((a) => repo.candidate(a.candidateId)).filter(Boolean);
check("every application's candidate was primed", people.length === rows.length, `${people.length}/${rows.length}`);
check("candidates carry a name", people.every((c) => c!.fullName), "");

const withTitle = people.filter((c) => c!.currentTitle).length;
check("most carry a current title", withTitle > people.length / 2, `${withTitle}/${people.length}`);

// ── a candidate nobody asked for ─────────────────────────────────────────────
console.log("\nthe miss check");
let missMsg = "";
try {
  repo.candidate("nosuchcandidateid");
} catch (e) {
  missMsg = (e as Error).message;
}
check("an unprimed candidate is a loud error, not a blank row", missMsg.includes("was not primed"), "");

console.log(failed === 0 ? "\nAll checks passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed ? 1 : 0);
