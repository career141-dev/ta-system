/**
 * A candidate profile, the way the page loads it — against the real backend.
 *
 * Reproduces the order a request actually runs in: the layout primes the
 * follow-up set and READS (building the store's indexes), then the page primes
 * one more person. That order is what made a profile 404 while its row sat in
 * memory, so it is checked here rather than in the browser.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/profile-check.ts <candidateId>
 */
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}
process.env.C141_STORE = "convex";

const { primeStore } = await import("@/data/prime");
const { repo } = await import("@/data/store");
const backend = await import("@/data/convex/backend");

const id = process.argv[2] || "j978dmw7t74ccwe7q5hdy4wtw98ec5gw";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// The layout: prime, then read — this builds the indexes.
await primeStore({ allApplications: true, followUps: true });
repo.applicationsForCandidate("warm-the-index");

// The page.
await primeStore({ candidateIds: [id] });
const c = repo.candidate(id);
check("candidate found after the index was already built", !!c, c?.fullName);
if (!c) process.exit(1);

check("LinkedIn is an absolute address", !c.linkedinUrl || /^https:\/\//.test(c.linkedinUrl), c.linkedinUrl ?? "none on file");
check("career carried onto the list row", c.workHistory.length > 0, `${c.workHistory.length} roles`);

const p = await backend.candidateProfile({ id: null }, id);
check("full profile loads", !!p);
if (p) {
  console.log(`\n  summary      ${p.summary ? p.summary.slice(0, 70) + "…" : "—"}`);
  console.log(`  career       ${p.career.length} roles${p.career[0] ? ` — ${p.career[0].title} (${p.career[0].from ?? "?"} – ${p.career[0].current ? "Present" : p.career[0].to ?? "?"})` : ""}`);
  console.log(`  education    ${p.education.length}`);
  console.log(`  languages    ${p.languages.join(", ") || "—"}`);
  console.log(`  referees     ${p.referees.length}`);
  console.log(`  matches      ${p.matches.map((m) => `${m.jobTitle}: ${m.score ?? "unscored"}`).join("; ") || "—"}`);
  console.log(`  cv           ${p.cv ? `${p.cv.fileName} (${p.cv.storage})` : "none on file"}`);
}

const link = await backend.cvLink({ id: null }, id);
console.log(`  cv link      ${link.ok ? "can be opened" : `${link.reason} — ${link.detail}`}\n`);

process.exit(failed ? 1 : 0);
