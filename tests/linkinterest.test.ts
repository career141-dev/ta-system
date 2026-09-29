/**
 * Excel Tables by interest and by day (the desk, 29 Sep): All / Pending /
 * Interested / Not interested over the same rows, L1, L2… by the day a row was
 * added, and the pipeline moving with the row — Interested is on the pipeline,
 * Not interested is Rejected there. Nobody is deleted or copied. Uses the same
 * store calls the setLinkInterest action makes, on a disposable seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-interest-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { interestOf, linkDays, dayOf, dayLabel, readLinkFilters } = await import("@/lib/linkViews");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const DAY = 86_400_000;

const ta = repo.users().find((u) => u.role === "ta")!;
const o = repo.openings()[0];
const appOf = (entryId: string) => {
  const e = repo.linkEntry(entryId)!;
  return e.candidateId ? (repo.applicationsForCandidate(e.candidateId).find((a) => a.openingId === o.id) ?? null) : null;
};
const statusOf = (entryId: string) => interestOf(repo.linkEntry(entryId)!, appOf(entryId));

console.log("\nstatus");
const a = repo.addLink(o.id, "https://linkedin.com/in/candidate-a-interest", ta.id, "Candidate Alpha");
eq("a new row is Pending, though it arrives Shortlisted", statusOf(a), "pending");
eq("Declined off the pipeline is Not interested", interestOf({ outcome: "declined" }, null), "not_interested");
eq("on the pipeline is Interested", interestOf({ outcome: "contacted" }, { stage: "ta_follow_up" }), "interested");
eq("rejected on the pipeline is Not interested", interestOf({ outcome: "shortlisted" }, { stage: "rejected" }), "not_interested");
eq("dropped out is Not interested", interestOf({ outcome: "shortlisted" }, { stage: "dropped_out" }), "not_interested");

console.log("\nPending → Interested → Not interested, one person throughout");
{
  const people = repo.candidates().length;
  // Interested: what setLinkInterest does — outcome, then onto the pipeline.
  repo.updateLink(a, { outcome: "shortlisted" });
  const made = repo.linkToApplication(a, ta.id);
  eq("they go onto the pipeline", made.ok, true);
  if (made.ok) repo.shortlist(made.applicationId, ta.id);
  eq("Interested", statusOf(a), "interested");
  eq("in TA Follow-up", appOf(a)?.stage, "ta_follow_up");
  const appId = appOf(a)!.id;

  // Not interested: rejected there with the reason, outcome Declined.
  repo.updateLink(a, { outcome: "declined" });
  const moved = repo.moveStage(appId, "rejected", ta.id, "Not interested");
  eq("the pipeline takes the rejection", moved.ok, true);
  eq("Not interested", statusOf(a), "not_interested");
  eq("Rejected, with the reason", [appOf(a)?.stage, appOf(a)?.rejectReason], ["rejected", "Not interested"]);
  eq("the same application, not a new one", appOf(a)?.id, appId);
  eq("still in the table", !!repo.linkEntry(a), true);

  // And back: Interested again brings the same application back.
  repo.updateLink(a, { outcome: "shortlisted" });
  const again = repo.linkToApplication(a, ta.id);
  eq("the same application is found again", again.ok && again.applicationId, appId);
  repo.moveStage(appId, "ta_follow_up", ta.id);
  eq("Interested again", statusOf(a), "interested");
  eq("one person created in all of it", repo.candidates().length, people + 1);
  eq("one application for them here", repo.applicationsForCandidate(repo.linkEntry(a)!.candidateId!).filter((x) => x.openingId === o.id).length, 1);
}

console.log("\nL1, L2, L3: the days rows were added");
{
  const rows = [{ createdAt: Date.UTC(2026, 8, 26, 5) }, { createdAt: Date.UTC(2026, 8, 26, 12) }, { createdAt: Date.UTC(2026, 8, 28, 5) }, { createdAt: Date.UTC(2026, 8, 27, 5) }];
  const days = linkDays(rows);
  eq("three working days", days.length, 3);
  eq("the first day is L1, whatever order the rows come in", rows.map((r) => dayOf(r, days)), [1, 1, 3, 2]);
  eq("labelled with the day it stands for", /^L2 · 27 Sept?$/.test(dayLabel(2, days[1])), true);
  // A late-evening row in Colombo is that Colombo day, not the UTC one.
  eq("days are Colombo days", dayOf({ createdAt: Date.UTC(2026, 8, 26, 20) }, linkDays([{ createdAt: Date.UTC(2026, 8, 26, 20) }, { createdAt: Date.UTC(2026, 8, 27, 5) }])), 1);

  // All Ls → Interested gathers every day's; L2 + Interested only that day's.
  const table = [
    { createdAt: 0, s: "interested" }, { createdAt: 0, s: "pending" },
    { createdAt: DAY, s: "interested" }, { createdAt: DAY, s: "not_interested" },
    { createdAt: 2 * DAY, s: "interested" }, { createdAt: 2 * DAY, s: "pending" },
  ];
  const d = linkDays(table);
  const pick = (status: string, day: number) => table.filter((r) => (!status || r.s === status) && (!day || dayOf(r, d) === day)).length;
  eq("All Ls → Interested: every day's", pick("interested", 0), 3);
  eq("All Ls → Pending: every day's", pick("pending", 0), 2);
  eq("All Ls → Not interested", pick("not_interested", 0), 1);
  eq("L2 only", pick("", 2), 2);
  eq("L2 + Interested", pick("interested", 2), 1);
  eq("All shows everyone", pick("", 0), 6);
}

console.log("\nthe address bar");
eq("status and day are read", readLinkFilters({ status: "not_interested", day: "2" }), { status: "not_interested", day: 2, addons: false });
eq("a made-up status is All", readLinkFilters({ status: "maybe" }).status, "");
eq("a bad day is All Ls", readLinkFilters({ day: "x" }).day, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
