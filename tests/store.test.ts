/**
 * The store's rules, run against a disposable copy of the seed — never the
 * platform's own data. Each block starts from a fresh seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-store-"));
process.chdir(tmp);
const { repo, setsForOpening } = await import("@/data/store");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const fresh = () => repo.reset();
const DAY = 86_400_000;

console.log("\nfinding 04: a damaged file is kept, not reseeded over");
fresh();
const dbFile = path.join(tmp, ".data", "db.json");
fs.writeFileSync(dbFile, "{ not json");
let threw = false;
try { repo.users(); } catch { threw = true; }
eq("the read fails loudly", threw, true);
eq("the damaged copy is kept", fs.readdirSync(path.join(tmp, ".data")).some((f) => f.startsWith("db.damaged-")), true);

console.log("\nshortlisting: owner, set, Follow-up, history");
fresh();
const ta = repo.users().find((u) => u.role === "ta")!;
const opening = repo.openings().find((o) => repo.applications(o.id).some((a) => a.stage === "new_cv" && !a.ownerTaId))!;
const fresh1 = repo.applications(opening.id).filter((a) => a.stage === "new_cv" && !a.ownerTaId);
const r = repo.shortlist(fresh1[0].id, ta.id);
const after = repo.application(fresh1[0].id)!;
eq("goes to Follow-up", after.stage, "follow_up");
eq("gets a set number", after.setNumber !== null, true);
eq("writes a history event", repo.events(after.id).some((e) => e.eventType === "shortlisted"), true);
const stamp = after.shortlistedAt;
repo.shortlist(fresh1[0].id, ta.id);
eq("shortlisting twice changes nothing", repo.application(fresh1[0].id)!.shortlistedAt, stamp);
eq("returns the stage", r.ok && r.stage, "follow_up");

console.log("\nsets: the day rule, per TA");
fresh();
{
  const o = repo.openings()[0];
  const me = repo.users().find((u) => u.role === "ta")!;
  const other = repo.users().filter((u) => u.role === "ta")[1]!;
  // Clear the seeded numbering on this opening so the rule is tested alone.
  const apps = repo.applications(o.id);
  const raw = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  for (const a of raw.applications) if (a.openingId === o.id) { a.setNumber = null; a.ownerTaId = null; a.shortlistedAt = null; a.stage = "new_cv"; }
  fs.writeFileSync(dbFile, JSON.stringify(raw));
  const ids = apps.map((a) => a.id);
  const setOf = (id: string) => repo.application(id)!.setNumber;
  const backdate = (id: string, days: number) => {
    const d = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    const a = d.applications.find((x: { id: string }) => x.id === id);
    a.shortlistedAt -= days * DAY;
    fs.writeFileSync(dbFile, JSON.stringify(d));
  };
  // Yesterday: three into set 1.
  for (const id of ids.slice(0, 3)) { repo.shortlist(id, me.id); backdate(id, 1); }
  // Today: four more — still set 1, because it had only three this morning.
  for (const id of ids.slice(3, 7)) repo.shortlist(id, me.id);
  eq("under five yesterday, today's still join set 1", ids.slice(3, 7).map(setOf), [1, 1, 1, 1]);
  eq("set 1 can pass five on the day", setsForOpening(o.id, me.id).find((s) => s.setNumber === 1)?.count, 7);
  for (const id of ids.slice(3, 7)) backdate(id, 1);
  repo.shortlist(ids[7], me.id);
  eq("the next day starts set 2", setOf(ids[7]), 2);
  if (other && ids[8]) {
    repo.shortlist(ids[8], other.id);
    eq("another TA on the same opening has their own set 1", setOf(ids[8]), 1);
  }
}

console.log("\nintake files itself");
fresh();
{
  const items = repo.intake();
  const by = (id: string) => items.find((i) => i.id === id);
  eq("a routed CV from somebody new is filed without a click", by("in_1")?.status === "admitted" || by("in_1")?.status === "merged", true);
  eq("somebody already on file is merged, not copied", items.filter((i) => i.match?.verdict === "same").every((i) => i.status === "merged"), true);
  eq("an unreadable CV waits for a person", by("in_5")?.status !== "admitted", true);
  eq("an unclear identity waits for a person", items.filter((i) => i.match?.verdict === "review").every((i) => i.status === "needs_review"), true);
  const filed = items.find((i) => i.status === "admitted" && i.openingId);
  if (filed) {
    const app = repo.applications(filed.openingId!).find((a) => a.candidateId === filed.candidateId);
    eq("filed as a New CV", app?.stage, "new_cv");
    eq("under an applicant channel, not SCOOP", app && app.sourcingChannel !== "SCOOP", true);
  }
}

console.log("\nintake: duplicates are refused at the write");
fresh();
{
  const item = repo.intake().find((i) => i.parsed?.fullName && i.match?.verdict === "new" && i.openingId);
  if (item) {
    const res = repo.admitIntake(item.id, repo.users()[0].id);
    const app = res.ok ? repo.applications(item.openingId!).find((a) => a.candidateId === res.candidateId) : null;
    eq("stage is New CVs, not a database match", app?.stage, "new_cv");
    eq("channel is not SCOOP", app?.sourcingChannel !== "SCOOP", true);
  } else console.log("  (no routed new intake item in the seed)");
  const same = repo.intake().find((i) => i.match?.verdict === "same" && i.status !== "admitted" && i.status !== "merged");
  if (same) eq("a confirmed duplicate is not admitted as new", repo.admitIntake(same.id, repo.users()[0].id).ok, false);
  else console.log("  (no same-person intake item in the seed)");
}

console.log("\nfinding 11: no live advert before the JD is approved");
fresh();
{
  const o = repo.openings()[0];
  const raw = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  raw.openings.find((x: { id: string }) => x.id === o.id).jdStatus = "pending_ta_approval";
  fs.writeFileSync(dbFile, JSON.stringify(raw));
  eq("adding a live advert is refused", repo.addJobPost(o.id, "Test advert", undefined, true).ok, false);
  eq("a draft is fine", repo.addJobPost(o.id, "Test advert", undefined, false).ok, true);
  const draft = repo.jobPosts(o.id).find((p) => p.title === "Test advert")!;
  eq("setting it live is refused", repo.updatePost(draft.id, { status: "live" }).ok, false);
  repo.updatePost(draft.id, { title: "Renamed advert" });
  eq("a rename keeps the old title for routing", repo.jobPosts(o.id).find((p) => p.id === draft.id)?.previousTitles, ["Test advert"]);
}

console.log("\nfinding 13: Placed needs a placement");
fresh();
{
  const offered = repo.applications().find((a) => a.stage === "offer" && !repo.placements?.().some?.((p: { applicationId: string }) => p.applicationId === a.id));
  if (offered) eq("moving to Placed by hand is refused", repo.moveStage(offered.id, "placed", null).ok, false);
}

console.log("\nfindings 18 and 19: replies merge, and late replies do not undo work");
fresh();
{
  const o = repo.openings()[0];
  const lead = repo.users().find((u) => u.role === "ta_lead")!;
  const inReview = repo.applications(o.id).filter((a) => a.stage === "follow_up").slice(0, 2);
  if (inReview.length === 2) {
    for (const a of inReview) repo.moveStage(a.id, "director_review", lead.id);
    const round = repo.openReviewRound({
      openingId: o.id, kind: "director", applicationIds: inReview.map((a) => a.id), sentBy: lead.id,
      sentTo: "director@career141.com", subject: "TEST", setNumber: null, trackedAt: null,
    } as Parameters<typeof repo.openReviewRound>[0]);
    const roundId = (round as { id?: string }).id ?? repo.awaitingReview(o.id).at(-1)!.id;
    repo.applyReviewDecisions(roundId, [{ applicationId: inReview[0].id, outcome: "shortlisted", note: null, confirmed: true }], "take 1");
    repo.applyReviewDecisions(roundId, [{ applicationId: inReview[1].id, outcome: "rejected", note: null, confirmed: true }], "not 2");
    const rr = repo.awaitingReview().concat([]).find((x) => x.id === roundId);
    const all = JSON.parse(fs.readFileSync(dbFile, "utf8")).reviewRounds.find((x: { id: string }) => x.id === roundId);
    eq("both decisions kept", all.decisions.length, 2);
    eq("round is returned, not partial", all.status, "returned");
    eq("no longer waiting", rr, undefined);
    const again = repo.applyReviewDecisions(roundId, [{ applicationId: inReview[0].id, outcome: "shortlisted", note: null, confirmed: true }], "take 1");
    eq("pasting the same reply twice is a repeat", again.repeated, 1);
    const late = repo.applyReviewDecisions(roundId, [{ applicationId: inReview[1].id, outcome: "shortlisted", note: null, confirmed: true }], "actually take 2");
    eq("a late change of mind about a rejected person is not auto-applied", late.stale, 1);
  } else console.log("  (not enough in follow-up to test)");
}

console.log("\na reply is read against everyone waiting, not one set");
fresh();
{
  const o = repo.openings()[0];
  const lead = repo.users().find((u) => u.role === "ta_lead")!;
  const people = repo.applications(o.id).filter((a) => a.stage === "follow_up").slice(0, 3);
  if (people.length === 3) {
    for (const a of people) repo.moveStage(a.id, "director_review", lead.id);
    const send = (ids: string[], subject: string) =>
      repo.openReviewRound({ openingId: o.id, kind: "director", applicationIds: ids, sentBy: lead.id, sentTo: "d@x", subject, setNumber: null, trackedAt: null } as Parameters<typeof repo.openReviewRound>[0]);
    send([people[0].id], "MONDAY");
    send([people[1].id, people[2].id], "TUESDAY");
    const waiting = repo.waitingOn(o.id, "director").map((w) => w.applicationId);
    eq("everyone from both emails is waiting", waiting.length, 3);
    eq("the newest email is numbered first", waiting[0], people[1].id);
    const res = repo.applyReply(o.id, "director", [
      { applicationId: people[0].id, outcome: "shortlisted", note: null, confirmed: false },
      { applicationId: people[2].id, outcome: "rejected", note: null, confirmed: false },
    ], "take the one from Monday, not the second one on Tuesday");
    eq("a person from Monday's email and one from Tuesday's both moved", [res.moved, res.rejected], [1, 1]);
    eq("only the undecided one still waits", repo.waitingOn(o.id, "director").map((w) => w.applicationId), [people[1].id]);
  }
}

// Windows refuses to delete a directory that is a process's CWD (EPERM), and
// can briefly hold locks on freshly written files — move out first, then retry.
process.chdir(os.tmpdir());
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
