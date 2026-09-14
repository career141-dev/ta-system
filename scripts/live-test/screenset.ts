/**
 * C141_DATA_DIR=.data-live-test node --import ./tests/alias.mjs scripts/live-test/screenset.ts
 *
 * Builds review/screenset.json: every person on the recruiter review lists, with
 * the full job description and the CV (names, emails, phones and LinkedIn taken
 * out), plus the recruiter's decision. Input for the recruiter-screen test.
 */
import fs from "node:fs";
import path from "node:path";
if (!(process.env.C141_DATA_DIR ?? "").trim()) { console.error("Set C141_DATA_DIR to the test folder."); process.exit(1); }

const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { reviewJobs, reviewList } = await import("@/lib/review");

const R = path.join(dataDir(), "review");
const decisions: { reviewerId: string; job: number; candidateId: string; decision: string; note: string }[] =
  JSON.parse(fs.readFileSync(path.join(R, "decisions.json"), "utf8"));

const jobs = reviewJobs().map((n) => {
  const o = repo.openings()[n - 1];
  // The copied "Requirements (from the job record)" block repeats the JD in fragments; the JD itself is enough.
  return { n, title: o.title, jd: o.jdMarkdown.split("## Requirements (from the job record)")[0].trim().slice(0, 6000) };
});

const items = reviewJobs().flatMap((job) => reviewList(job).map((id, i) => {
  const c = repo.candidate(id)!;
  const names = (c.fullName ?? "").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let cv = (repo.cvTextFor(id) ?? "").split("\n").filter((l) => !/@|\+?\d[\d\s-]{7,}|linkedin\.com/i.test(l)).join("\n");
  for (const w of names) cv = cv.replace(new RegExp(`\\b${w}\\b`, "gi"), "[name]");
  cv = cv.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const d = decisions.filter((r) => r.job === job && r.candidateId === id);
  return {
    job, no: i + 1, id,
    decisions: Object.fromEntries(d.map((r) => [r.reviewerId, r.decision])),
    profile: {
      currentTitle: c.currentTitle, employer: c.currentEmployer, years: c.totalExperienceYears, location: c.location,
      history: c.workHistory.slice(0, 8).map((h) => `${h.title} — ${h.employer} (${h.fromYear || "?"}–${h.toYear ?? "now"})`),
      education: [c.educationDegree, c.educationInstitution].filter(Boolean).join(", "),
      cv: cv.slice(0, 6000),
    },
  };
}));
fs.writeFileSync(path.join(R, "screenset.json"), JSON.stringify({ jobs, items }));
console.log(`jobs ${jobs.length} · people ${items.length}`);
process.exit(0);
