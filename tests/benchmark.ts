/**
 * How long the everyday operations take at a live-sized database.
 *
 *   npm run bench            # 20,000 candidates
 *   npm run bench -- 115000  # the current system's size
 *
 * Runs on an invented copy of the seed in a temporary folder — never the
 * platform's own data — with the no-key vector stand-in, so it costs nothing.
 * Not part of `npm test`: it is a measurement, not a pass/fail check.
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "C141_EMBED_MODEL"]) delete process.env[k];
const N = Number(process.argv[2] ?? 20000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-perf-")); process.chdir(tmp);
const t = async (label: string, fn: () => unknown) => { const s = performance.now(); const r = await fn(); console.log(`${label.padEnd(46)} ${Math.round(performance.now() - s).toString().padStart(7)} ms`); return r; };
const { repo } = await import("@/data/store");
repo.reset();
const file = path.join(tmp, ".data", "db.json");
const db = JSON.parse(fs.readFileSync(file, "utf8"));
const base = db.candidates;
const out: any[] = [];
for (let i = 0; i < N; i++) { const c = base[i % base.length]; out.push({ ...c, id: i < base.length ? c.id : `cx_${i}`, email: c.email ? `x${i}_${c.email}` : null, phone: c.phone ? `${c.phone}${i}` : null }); }
db.candidates = out;
// A realistic intake log: one CV text per candidate would be 115k files; use 5,000 items.
const intake = db.intake[0];
if (intake) db.intake = Array.from({ length: Math.min(N, 5000) }, (_, i) => ({ ...intake, id: `ix_${i}`, candidateId: out[i % out.length].id }));
fs.writeFileSync(file, JSON.stringify(db, null, 2));
console.log(`\n${N.toLocaleString()} candidates — db.json ${(fs.statSync(file).size / 1e6).toFixed(0)} MB`);
const store = await import("@/data/store");
const { parseQuery } = await import("@/lib/query");
const { requirementsFromOpening, scoreSet } = await import("@/lib/scoring");
const { findDatabaseMatches, refreshCandidateVectors } = await import("@/lib/dbMatch");
const { computeAlerts } = await import("@/lib/sla");
await t("first read of the database (parse)", () => repo.candidates().length);
const vocab = await t("vocabulary (every list, search box)", () => repo.vocabulary()) as any;
await t("  …again", () => repo.vocabulary());
const crit = parseQuery("brand manager in Colombo with 5 years", vocab).criteria;
await t("database search: plain English", () => repo.searchDatabase(crit, { limit: 25 }));
await t("database search: Boolean", () => repo.searchDatabase(parseQuery("", vocab).criteria, { boolean: '"Brand Manager" AND Marketing', limit: 25 }));
const o = repo.openings().find((x) => x.jdStatus === "approved")!;
await t("score one pipeline list (req + 50 CVs)", () => { const req = requirementsFromOpening({ title: o.title, jdMarkdown: o.jdMarkdown, locations: o.locations, targetNationalities: o.targetNationalities, industry: null, knownSkills: repo.vocabulary().skills }); return scoreSet(repo.applications(o.id).slice(0, 50).map((a) => ({ candidate: repo.candidate(a.candidateId)! })), req); });
await t("alerts (header badge, every page)", () => computeAlerts());
await t("one small save (a setting)", () => repo.setSetting("perf", "1"));
await t("read after a save", () => repo.candidates().length);
await t("vectors: build for all CVs (local stand-in)", () => refreshCandidateVectors());
await t("vectors: check up to date (every meaning search)", () => refreshCandidateVectors());
await t("database matches for one job", () => findDatabaseMatches(o.id, "manual"));
