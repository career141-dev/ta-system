/**
 * C141_DATA_DIR=.data-live-test node --import ./tests/alias.mjs scripts/live-test/compare-review.ts [reviewerId]
 *
 * Step 2 of the quality plan (14 September): compares a recruiter's review
 * decisions with (a) my blind labels and (b) the platform's current rules score,
 * for every person on the review lists. Writes review/compare-<reviewer>.json.
 */
import fs from "node:fs";
import path from "node:path";
if (!(process.env.C141_DATA_DIR ?? "").trim()) { console.error("Set C141_DATA_DIR to the test folder."); process.exit(1); }

const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { requirementsFor } = await import("@/lib/dbMatch");
const { FIT_BANDS, scoreSet } = await import("@/lib/scoring");
const { reviewJobs, reviewList } = await import("@/lib/review");

const D = dataDir();
const decisions: { reviewerId: string; job: number; candidateId: string; decision: string }[] =
  JSON.parse(fs.readFileSync(path.join(D, "review", "decisions.json"), "utf8"));
const labels: Record<string, number> = JSON.parse(fs.readFileSync(path.join(D, "judging", "labels-all.json"), "utf8"));
const reviewers = [...new Set(decisions.map((d) => d.reviewerId))];
const reviewer = process.argv[2] ?? reviewers[0];

/** Area under the curve: chance a random "yes" person scores above a random "no" person. */
const auc = (rows: { s: number; y: boolean }[]) => {
  const pos = rows.filter((r) => r.y), neg = rows.filter((r) => !r.y);
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p.s > n.s ? 1 : p.s === n.s ? 0.5 : 0;
  return Number((w / (pos.length * neg.length)).toFixed(2));
};

const out: Record<string, unknown>[] = [];
const all: { job: number; no: number; title: string; decision: string; mine: number; score: number }[] = [];
for (const job of reviewJobs()) {
  const o = repo.openings()[job - 1];
  const req = requirementsFor(o.id)!;
  const ids = reviewList(job);
  const scores = new Map(scoreSet(ids.map((id) => ({ candidate: repo.candidate(id)!, cvText: repo.cvTextFor(id), vector: 0 })), req).map((s) => [s.candidate.id, s.score.overall]));
  const mine = new Map(decisions.filter((d) => d.reviewerId === reviewer && d.job === job).map((d) => [d.candidateId, d.decision]));
  const rows = ids.map((id, i) => {
    const c = repo.candidate(id)!;
    return { job, no: i + 1, title: `${c.currentTitle ?? "?"} · ${c.currentEmployer ?? "?"} · ${Math.round(c.totalExperienceYears ?? 0)}y`, decision: mine.get(id) ?? "—", mine: labels[`${job}|${id}`] ?? -1, score: scores.get(id) ?? 0 };
  });
  all.push(...rows);
  const decided = rows.filter((r) => r.decision !== "—");
  const yes = (r: typeof rows[number]) => r.decision !== "reject"; // shortlist or maybe
  const count = (f: (r: typeof rows[number]) => boolean) => decided.filter(f).length;
  const summary = {
    job, title: o.title, reviewed: decided.length,
    reviewer: { shortlist: count((r) => r.decision === "shortlist"), maybe: count((r) => r.decision === "maybe"), reject: count((r) => r.decision === "reject") },
    myLabels: { "3 strong": count((r) => r.mine === 3), "2 possible": count((r) => r.mine === 2), "1 weak": count((r) => r.mine === 1), "0 no": count((r) => r.mine === 0) },
    // Mine says 2+ is worth a look; the reviewer says shortlist or maybe.
    agreeWithMe: `${count((r) => (r.mine >= 2) === yes(r))}/${decided.length}`,
    iSaidYesTheySaidReject: count((r) => r.mine >= 2 && !yes(r)),
    iSaidNoTheySaidYes: count((r) => r.mine < 2 && yes(r)),
    platform: {
      addedAtWorth: count((r) => r.score >= FIT_BANDS.worth),
      ofThoseReviewerYes: count((r) => r.score >= FIT_BANDS.worth && yes(r)),
      reviewerYesMissed: count((r) => r.score < FIT_BANDS.worth && yes(r)),
      aucVsReviewer: auc(decided.map((r) => ({ s: r.score, y: yes(r) }))),
      aucVsMyLabels: auc(decided.map((r) => ({ s: r.score, y: r.mine >= 2 }))),
    },
  };
  out.push(summary);
  console.log(JSON.stringify(summary, null, 1));
  console.log("  disagreements (review page #, mine 0-3, platform score):");
  for (const r of decided.filter((r) => (r.mine >= 2) !== yes(r) || (r.score >= FIT_BANDS.worth) !== yes(r)).sort((a, b) => a.no - b.no))
    console.log(`   #${r.no} ${r.decision.padEnd(9)} mine ${r.mine} score ${String(r.score).padStart(3)}  ${r.title}`);
}
fs.writeFileSync(path.join(D, "review", `compare-${reviewer}.json`), JSON.stringify({ reviewer, jobs: out, rows: all }, null, 1));
console.log(`\nreviewers with decisions: ${reviewers.join(", ")} · compared: ${reviewer}`);
process.exit(0);
