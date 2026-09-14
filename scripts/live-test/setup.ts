/**
 * C141_DATA_DIR=.data-live-test node --import ./tests/alias.mjs scripts/live-test/setup.ts <jobs.json> [--pages 200]
 *
 * Builds the live-data test copy (13 September): an EMPTY database (the team's
 * user seats only — no invented candidates, clients or jobs), the 12 live jobs,
 * then the first 10,000 CVs over the read-only link, embedded as they arrive.
 * Everything paid runs under the $5 hard stop. Nothing is written anywhere
 * except the test folder.
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }
// The dashboard address sometimes ends up in the settings; the data API is here.
process.env.C141_LIVE_CONVEX_URL = "https://api.career141.com";

const dir = (process.env.C141_DATA_DIR ?? "").trim();
if (!dir || path.resolve(dir) === path.join(process.cwd(), ".data")) {
  console.error("Set C141_DATA_DIR to a separate test folder first (e.g. .data-live-test).");
  process.exit(1);
}
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const jobsFile = process.argv[2];
const pages = Number(arg("pages", "200"));
const pageSize = 50;

const { dataDir } = await import("@/data/dataDir");
const { buildSeed } = await import("@/data/seed");
const { asBullets } = await import("@/lib/scoring");
const { normaliseIndustry } = await import("@/lib/profileInfer");
const root = dataDir();
fs.mkdirSync(root, { recursive: true });
const dbFile = path.join(root, "db.json");

if (!fs.existsSync(dbFile)) {
  const seed = buildSeed() as unknown as Record<string, unknown>;
  // Keep the seats and settings; every invented person, client and job goes.
  for (const [k, v] of Object.entries(seed)) if (Array.isArray(v) && k !== "users") seed[k] = [];
  const jobs = JSON.parse(fs.readFileSync(jobsFile, "utf8")) as any[];
  fs.copyFileSync(jobsFile, path.join(root, "live-jobs.json"));
  const now = Date.now();
  const ta = "u_nuha";
  const clients = new Map<string, any>();
  const openings = jobs.map((j, i) => {
    const clientKey = String(j.client).trim().toUpperCase();
    if (!clients.has(clientKey)) {
      clients.set(clientKey, { id: `cl_live_${clients.size + 1}`, name: j.client, industry: normaliseIndustry(j.industry) ?? j.industry ?? "", contacts: [], esaSignedAt: null, status: "active", createdAt: now });
    }
    // The JD as the team wrote it, read into bullets, then what the team typed
    // into the job record — required skills, years, education — as a section
    // the requirement reader treats as the requirements.
    const fromRecord = [
      "## Requirements (from the job record)",
      ...(j.expMin ? [`- Minimum ${j.expMin} years of experience`] : []),
      ...(j.edu ? [`- ${j.edu}`] : []),
      ...(j.skills ?? []).map((s: string) => `- ${s}`),
      ...((j.nice ?? []).length ? ["", "## Preferred", ...(j.nice as string[]).map((s) => `- ${s}`)] : []),
    ].join("\n");
    return {
      id: `op_live_${i + 1}`, clientId: clients.get(clientKey).id, title: j.title,
      positionCode: `LIVE-${String(i + 1).padStart(2, "0")}`, jobOrderNumber: `LIVE-${j.id}`,
      jdMarkdown: `${asBullets(j.jd ?? "")}\n\n${fromRecord}`, followUpQuestions: [],
      jdStatus: "approved", jdApprovedBy: "u_lead", jdApprovedAt: now, briefId: null,
      salaryMin: null, salaryMax: null, salaryCurrency: "LKR", packageNotes: "",
      targetGender: null, targetNationalities: [], locations: j.location ? [String(j.location).replace(/\s*\((?:on-?site|hybrid|remote)\)\s*/i, "").trim()] : [],
      headcount: 1, priorityTier: "P3", positionStatus: "active", assignedTaIds: [ta], taLeadId: "u_lead", directorId: "u_dir",
      requirementReceivedAt: now, assignedAt: now, closedAt: null, valueOnProgressing: null, valueOfPlacement: null, valueLost: null,
      status: "open", createdAt: now, updatedAt: now,
    };
  });
  seed.clients = [...clients.values()];
  seed.openings = openings;
  fs.writeFileSync(dbFile, JSON.stringify(seed));
  console.log(`Test database created: ${openings.length} live jobs, ${clients.size} clients, no invented data.`);
}

const { ReadOnlyConvex, liveConvexConfigFromEnv } = await import("@/lib/live/readOnlyConvex");
const { syncLive } = await import("@/lib/live/sync");
const { spentSoFar } = await import("@/lib/spend");
const client = new ReadOnlyConvex(liveConvexConfigFromEnv()!);
const t0 = Date.now();
const r = await syncLive(client, {
  pageSize, maxPages: pages, skipVectors: process.argv.includes("--no-embed"),
  onPage: (n) => { if (n % 1000 === 0) console.log(`${n} CVs · ${Math.round((Date.now() - t0) / 1000)}s · $${spentSoFar().toFixed(4)} spent`); },
});
console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000), spent: spentSoFar() }));
