/**
 * Excel Tables by interest and by L (the desk, 29 Sep): All / Pending /
 * Interested / Not interested over the same rows, L1, L2… as each TA starts
 * them with the sidebar's +, and the pipeline moving with the row — Interested
 * is on the pipeline, Not interested is Rejected there. Nobody is deleted or
 * copied. Uses the same store calls the actions make, on a disposable seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-interest-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { interestOf, levelLabel, readLinkFilters } = await import("@/lib/linkViews");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const [ta, other] = repo.users().filter((u) => u.role === "ta");
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
// 1 Oct: Ajith, linked to his record, sat in Database matches; the row said
// Interested, so the Interested button was hidden and nobody could move him on.
eq("in Database matches, not yet taken on by a TA, is Pending", interestOf({ outcome: "shortlisted" }, { stage: "matched" }), "pending");
eq("…and in New CVs", interestOf({ outcome: "shortlisted" }, { stage: "new_cv" }), "pending");
eq("…and on the AI's own shortlist", interestOf({ outcome: "shortlisted" }, { stage: "ai_follow_up" }), "pending");

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

console.log("\nNot interested, never on the pipeline: straight into Rejected");
{
  const b = repo.addLink(o.id, "https://linkedin.com/in/candidate-b-never", ta.id, "Candidate Bravo");
  eq("Pending before", statusOf(b), "pending");
  // What setLinkInterest does: outcome Declined, then onto the pipeline as Rejected.
  repo.updateLink(b, { outcome: "declined" });
  const made = repo.linkToApplication(b, ta.id, { rejected: "Not interested" });
  eq("they go onto the pipeline", made.ok, true);
  eq("as Rejected, with the reason", [appOf(b)?.stage, appOf(b)?.rejectReason, appOf(b)?.rejectedBy], ["rejected", "Not interested", ta.id]);
  eq("Not interested", statusOf(b), "not_interested");
  eq("still in the table", !!repo.linkEntry(b), true);
  const n = repo.addLink(o.id, "https://linkedin.com/in/zz-no-name-9", ta.id, null);
  repo.updateLink(n, { outcome: "declined", name: null });
  const refused = repo.linkToApplication(n, ta.id, { rejected: "Not interested" });
  eq("without a name it is refused, and nothing is added", [refused.ok, repo.linkEntry(n)!.candidateId ?? null], [false, null]);

  // The TA's reason (the desk, 29 Sep): on the Rejected entry and the row's log.
  const w = repo.addLink(o.id, "https://linkedin.com/in/candidate-why-9", ta.id, "Candidate Why");
  repo.updateLink(w, { outcome: "declined" });
  repo.linkToApplication(w, ta.id, { rejected: "Not interested — happy where they are" });
  repo.logOutreach(w, ta.id, "Not interested", "happy where they are");
  eq("the reason is on the Rejected entry", appOf(w)?.rejectReason, "Not interested — happy where they are");
  eq("and on the row's log", repo.linkEntry(w)!.conversationLog.at(-1)?.note, "happy where they are");
  eq("logging it does not change the Declined outcome", repo.linkEntry(w)!.outcome, "declined");
}

console.log("\nL1, L2, L3: started with + by each TA");
{
  const before = repo.addLink(o.id, "https://linkedin.com/in/before-any-l", ta.id, "Before Any");
  eq("before their first +, a row is in no L", repo.linkEntry(before)!.level ?? null, null);
  eq("+ starts L1", repo.addLinkLevel(o.id, ta.id), 1);
  const one = repo.addLink(o.id, "https://linkedin.com/in/in-l-one", ta.id, "In One");
  eq("a row added now is in L1", repo.linkEntry(one)!.level, 1);
  eq("+ again starts L2", repo.addLinkLevel(o.id, ta.id), 2);
  const two = repo.addLink(o.id, "https://linkedin.com/in/in-l-two", ta.id, "In Two");
  eq("and rows go into the latest", repo.linkEntry(two)!.level, 2);
  eq("L1 keeps its row", repo.linkEntry(one)!.level, 1);
  eq("the TA has two L's", repo.linkLevels(o.id, ta.id).length, 2);
  eq("another TA has none of them", repo.linkLevels(o.id, other.id).length, 0);
  eq("another TA's first + is their own L1", repo.addLinkLevel(o.id, other.id), 1);
  eq("labelled with the day it was started", /^L2 · \d{1,2} \w{3,4}$/.test(levelLabel(repo.linkLevels(o.id, ta.id)[1])), true);

  // Rename and delete (the desk, 29 Sep).
  eq("an L can be named", repo.renameLinkLevel(o.id, ta.id, 2, "  Banks  "), true);
  eq("and shows its name", levelLabel(repo.linkLevels(o.id, ta.id)[1]), "L2 · Banks");
  repo.renameLinkLevel(o.id, ta.id, 2, "");
  eq("a blank name puts the date back", /^L2 · \d/.test(levelLabel(repo.linkLevels(o.id, ta.id)[1])), true);
  eq("another TA's L cannot be renamed through yours", repo.renameLinkLevel(o.id, ta.id, 5, "X"), false);
  const rows = repo.linkVault(o.id).length;
  eq("deleting L1 reports its one row", repo.deleteLinkLevel(o.id, ta.id, 1), 1);
  eq("L1 is gone from the list", repo.linkLevels(o.id, ta.id).map((l) => l.n), [2]);
  eq("its row is still in the table", repo.linkVault(o.id).length, rows);
  eq("in no L now", repo.linkEntry(one)!.level ?? null, null);
  eq("L2 keeps its number and its row", repo.linkEntry(two)!.level, 2);
  eq("deleting it twice does nothing", repo.deleteLinkLevel(o.id, ta.id, 1), null);
  eq("the next + is L3, not a second L1", repo.addLinkLevel(o.id, ta.id), 3);
  const three = repo.addLink(o.id, "https://linkedin.com/in/in-l-three", ta.id, "In Three");
  eq("new rows go into it", repo.linkEntry(three)!.level, 3);
  repo.deleteLinkLevel(o.id, ta.id, 3);
  const after = repo.addLink(o.id, "https://linkedin.com/in/after-delete", ta.id, "After Delete");
  eq("with the latest deleted, rows go into the latest still there", repo.linkEntry(after)!.level, 2);

  // All Ls → Interested gathers every L's; L2 + Interested only L2's.
  const table = [
    { level: 1, s: "interested" }, { level: 1, s: "pending" },
    { level: 2, s: "interested" }, { level: 2, s: "not_interested" },
    { level: 3, s: "interested" }, { level: null, s: "pending" },
  ];
  const pick = (status: string, level: number) => table.filter((r) => (!status || r.s === status) && (!level || r.level === level)).length;
  eq("All Ls → Interested: every L's", pick("interested", 0), 3);
  eq("All Ls → Pending, including rows in no L", pick("pending", 0), 2);
  eq("All Ls → Not interested", pick("not_interested", 0), 1);
  eq("L2 only", pick("", 2), 2);
  eq("L2 + Interested", pick("interested", 2), 1);
  eq("All shows everyone", pick("", 0), 6);
}

console.log("\nthe address bar");
eq("status and L are read", readLinkFilters({ status: "not_interested", level: "2" }), { status: "not_interested", level: 2, addons: false, by: "" });
eq("a made-up status is All", readLinkFilters({ status: "maybe" }).status, "");
eq("a bad L is All Ls", readLinkFilters({ level: "x" }).level, 0);

console.log("\ntwo TAs on one opening: whose rows, and no duplicates (1 Oct)");
{
  const { linkKey } = await import("@/lib/url");
  eq("added by: one person's rows", readLinkFilters({ by: "u_hassan" }).by, "u_hassan");
  eq("added by: nonsense is everyone", readLinkFilters({ by: "<script>" }).by, "");
  const rec = "https://www.linkedin.com/talent/hire/2151390298/discover/recruiterSearch/profile/AEMAACJp05QBEw6SFXmbmHUmR5wG3wKSWBK2ItY";
  eq("a Recruiter page has a key: the profile's own id", linkKey(rec), "linkedin.com/talent/profile/aemaacjp05qbew6sfxmbmhumr5wg3wkswbk2ity");
  eq("…the same from another Recruiter search", linkKey(rec.replace("2151390298/discover/recruiterSearch", "999/pipeline")), linkKey(rec));
  eq("a public profile's key is unchanged", linkKey("lk.linkedin.com/in/Kgpk/"), "linkedin.com/in/kgpk");
  const r1 = repo.addLink(o.id, rec, ta.id, "Thivanka Nimesh");
  eq("captured again from Recruiter: found, not added", repo.findLinkByUrl(o.id, linkKey(rec)!)?.id, r1);
  repo.updateLink(r1, { company: "Virtusa (Pvt) Ltd" });
  eq("the same name at the same company, from a public profile: found", repo.findLinkByPerson(o.id, "Thivanka Nimesh", "Virtusa")?.id, r1);
  eq("the same name at another company: a different person", repo.findLinkByPerson(o.id, "Thivanka Nimesh", "Dialog Axiata"), undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
