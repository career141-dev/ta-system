/**
 * C141_DATA_DIR=.data-live-test node --import ./tests/alias.mjs scripts/live-test/matches.ts
 *
 * Step 2 of the live-data test (13 September): embeds the copied CVs (under the
 * $5 hard stop), runs database matches for every test job, and writes a blind
 * judging sheet per job. The sheet mixes, without saying which is which:
 *
 *   shown        — the people the platform added
 *   just_below   — within 10 points under the match bar, where good people get cut off
 *   title_match  — their job title looks right but they were not added
 *   ruled_out    — removed by a hard rule
 *   thin         — close in meaning, thin record, not added
 *
 * The bucket key is written to a separate file, read only after judging.
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }
if (!(process.env.C141_DATA_DIR ?? "").trim()) { console.error("Set C141_DATA_DIR to the test folder."); process.exit(1); }

const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { findDatabaseMatches, failsHardRules, refreshCandidateVectors, requirementsFor } = await import("@/lib/dbMatch");
const { cosine, candidateVector, ensureVectors, openingEmbedText, openingVector } = await import("@/lib/embed");
const { FIT_BANDS, scoreSet, titleScore } = await import("@/lib/scoring");
const { spentSoFar } = await import("@/lib/spend");
const { industryExperience, inferNationality } = await import("@/lib/profileInfer");

const out = path.join(dataDir(), "judging");
fs.mkdirSync(out, { recursive: true });

console.log(`CVs in the test copy: ${repo.candidates().length}`);
const t0 = Date.now();
const emb = await refreshCandidateVectors();
if (!emb.ok) { console.error(`Embedding stopped: ${emb.reason}`); process.exit(1); }
console.log(`Embedded ${emb.embedded} CVs (${emb.tokens} tokens) in ${Math.round((Date.now() - t0) / 1000)}s · $${spentSoFar().toFixed(4)} spent so far`);

/** A profile a recruiter can judge, with no name or contact details. */
function profile(id: string) {
  const c = repo.candidate(id)!;
  const text = (repo.cvTextFor(id) ?? "")
    .split("\n").filter((l) => !/@|\+?\d[\d\s-]{7,}|linkedin\.com/i.test(l)).join(" ")
    .replace(/\s+/g, " ").trim();
  const nat = inferNationality(c, text);
  return {
    title: c.currentTitle ?? "",
    employer: c.currentEmployer ?? "",
    years: c.totalExperienceYears,
    location: c.location,
    likelyNationality: nat ? `${nat.value} (${nat.confidence})` : null,
    industries: industryExperience(c).slice(0, 3).map((x) => `${x.industry} ${Math.round(x.years)}y`),
    history: c.workHistory.slice(0, 4).map((h) => `${h.title} — ${h.employer}${h.fromYear ? ` (${h.fromYear}–${h.toYear ?? "now"})` : ""}`),
    skills: c.skills.slice(0, 12),
    education: [c.educationDegree, c.educationInstitution].filter(Boolean).join(", "),
    cv: text.slice(0, 700),
  };
}

const shuffle = <T,>(xs: T[], seed: number) => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const summary: Record<string, unknown>[] = [];
for (const [n, o] of repo.openings().entries()) {
  const req = requirementsFor(o.id)!;
  const before = new Set(repo.applications(o.id).map((a) => a.candidateId));
  const r = await findDatabaseMatches(o.id, "manual");
  if (!r.ok) { console.log(`${o.title}: ${r.reason}`); continue; }
  const shown = repo.applications(o.id).filter((a) => !before.has(a.candidateId)).map((a) => a.candidateId);
  const shownSet = new Set(shown);

  // Everyone, scored the same way the run scores, to find the ones it did not add.
  await ensureVectors("openings", [{ id: o.id, text: openingEmbedText(o, repo.client(o.clientId)?.industry ?? null) }]);
  const jobVec = openingVector(o.id)!;
  const all = repo.candidates().map((c) => {
    const v = candidateVector(c.id);
    return { c, sim: v ? cosine(jobVec, v) : 0, title: Math.max(titleScore(c.currentTitle, req.title, req.titleVariants), ...c.workHistory.slice(0, 2).map((h) => titleScore(h.title, req.title, req.titleVariants))) };
  }).sort((a, b) => b.sim - a.sim);
  const pool = all.slice(0, 800);
  const scored = new Map(scoreSet(pool.map((p) => ({ candidate: p.c, cvText: repo.cvTextFor(p.c.id), vector: Math.max(0, p.sim) })), req).map((s) => [s.candidate.id, s.score.overall]));
  const notShown = pool.filter((p) => !shownSet.has(p.c.id));

  const ruled = notShown.filter((p) => failsHardRules(p.c, { ...o, localOnly: req.localOnly }, req.minYears) !== null);
  const ruledSet = new Set(ruled.map((p) => p.c.id));
  const eligible = notShown.filter((p) => !ruledSet.has(p.c.id));
  const buckets: Record<string, string[]> = {
    shown,
    just_below: eligible.filter((p) => (scored.get(p.c.id) ?? 0) >= FIT_BANDS.worth - 10 && (scored.get(p.c.id) ?? 0) < FIT_BANDS.worth).slice(0, 10).map((p) => p.c.id),
    title_match: shuffle(all.filter((p) => !shownSet.has(p.c.id) && !ruledSet.has(p.c.id) && p.title >= 50), n + 1).slice(0, 10).map((p) => p.c.id),
    ruled_out: ruled.slice(0, 5).map((p) => p.c.id),
    thin: eligible.filter((p) => p.c.skills.length < 3 && p.c.workHistory.length === 0).slice(0, 5).map((p) => p.c.id),
  };
  const key: Record<string, string> = {};
  for (const [b, ids] of Object.entries(buckets)) for (const id of ids) key[id] ??= b;
  const ids = shuffle(Object.keys(key), n + 7);
  fs.writeFileSync(path.join(out, `job${n + 1}-sheet.json`), JSON.stringify({
    job: { n: n + 1, title: o.title, client: repo.client(o.clientId)?.name, location: o.locations.join(", "), minYears: req.minYears, requiredSkills: req.requiredSkills, musts: req.qualitativeMusts, qualifications: req.requiredQualifications, industries: req.industries, industryRequired: req.industryRequired },
    people: ids.map((id, i) => ({ k: i + 1, ...profile(id) })),
  }, null, 1));
  fs.writeFileSync(path.join(out, `job${n + 1}-key.json`), JSON.stringify(ids.map((id, i) => ({ k: i + 1, id, bucket: key[id], score: scored.get(id) ?? null, sim: Number((all.find((p) => p.c.id === id)?.sim ?? 0).toFixed(3)) }))));
  const row = { job: n + 1, title: o.title, added: r.run!.added, considered: r.run!.considered, afterRules: r.run!.afterRules, note: r.run!.note, toJudge: ids.length };
  summary.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(out, "matches-summary.json"), JSON.stringify({ spent: spentSoFar(), jobs: summary }, null, 1));
console.log(`Done · $${spentSoFar().toFixed(4)} spent so far`);
