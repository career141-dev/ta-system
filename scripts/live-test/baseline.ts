/**
 * The current system's own automatic shortlist, judged the same way (13 September).
 * Reads each test job's applicants over the read-only link, takes up to 12 the
 * live system moved to "TA shortlist" (it does that automatically on its AI score)
 * and up to 12 it left in New CVs, and writes a blind sheet — no names, no contacts.
 * Also scores the same people with this platform's rules, for a like-for-like comparison.
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }
process.env.C141_LIVE_CONVEX_URL = "https://api.career141.com";
const { ReadOnlyConvex, liveConvexConfigFromEnv, READ_FUNCTIONS } = await import("@/lib/live/readOnlyConvex");
const { mapCandidate } = await import("@/lib/live/mapLive");
const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { requirementsFor } = await import("@/lib/dbMatch");
const { scoreCandidate } = await import("@/lib/scoring");
const c = new ReadOnlyConvex(liveConvexConfigFromEnv()!);
const live = JSON.parse(fs.readFileSync(path.join(dataDir(), "live-jobs.json"), "utf8"));
const PICKED = new Set(["ta_shortlist", "second_shortlist", "director_shortlist", "client_review", "interview", "offer", "placed", "follow_up", "ai_call"]);
let seed = 11;
const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const out: Record<string, unknown> = {};
for (const [i, j] of live.entries()) {
  const docs = await c.query<any[]>(READ_FUNCTIONS.applicantsForJob, { jobId: j.id });
  const rows = docs.map((d) => ({ d, stage: (d.activeApplicationsSummary ?? []).find((x: any) => x.jobId === j.id)?.stage ?? null }));
  const picked = rows.filter((r) => PICKED.has(r.stage));
  const notPicked = rows.filter((r) => r.stage === "new_cvs");
  if (picked.length < 4 || notPicked.length < 8) { console.log(`job ${i + 1}: ${picked.length} shortlisted by the live system — skipped`); continue; }
  const sample = [...picked.sort(() => rnd() - 0.5).slice(0, 12).map((r) => ({ ...r, live: 1 })), ...notPicked.sort(() => rnd() - 0.5).slice(0, 12).map((r) => ({ ...r, live: 0 }))].sort(() => rnd() - 0.5);
  const o = repo.openings()[i];
  const req = requirementsFor(o.id)!;
  out[String(i + 1)] = sample.map((r, k) => {
    const cand = mapCandidate(r.d, null);
    return {
      k: k + 1, live: r.live, ours: scoreCandidate(cand, req).overall,
      profile: { title: cand.currentTitle ?? "", employer: cand.currentEmployer ?? "", years: cand.totalExperienceYears, location: cand.location, history: cand.workHistory.slice(0, 4).map((h) => `${h.title} — ${h.employer}`), past: (r.d.pastJobTitles ?? []).slice(0, 4), skills: cand.skills.slice(0, 10), education: [cand.educationDegree, cand.educationInstitution].filter(Boolean).join(", "), summary: String(r.d.summary ?? "").slice(0, 300) },
    };
  });
  console.log(`job ${i + 1}: ${picked.length} shortlisted by the live system, ${notPicked.length} left in New CVs → sample ${sample.length}`);
}
fs.writeFileSync(path.join(dataDir(), "judging", "baseline.json"), JSON.stringify(out));
