/**
 * The end-of-day L-sheet line (the desk, 28 Sep): every column comes from the
 * records, and only the CVs the TA sends the Director today are counted —
 * never everyone mailed in, worked or applied. Each of them sits in exactly
 * one column — backup, then scoop, then add-on, then DA / POST / L by where it
 * came from — so the columns add up to the day's total.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-effort-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { effortRow, effortFromForm, effortBucket, shortlistRows } = await import("@/lib/eod");
const { dayTotal, setsCell, eodEmailHtml } = await import("@/lib/eod-format");
import type { Id, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const dbFile = () => path.join(tmp, ".data", "db.json");
const busiest = () => [...repo.openings()].sort((x, y) => repo.applications(y.id).length - repo.applications(x.id).length)[0];
const edit = (fn: (db: any) => void) => {
  const raw = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  fn(raw);
  fs.writeFileSync(dbFile(), JSON.stringify(raw));
};
const shortlistRowsIds = (openingId: Id, ta: User) => shortlistRows(openingId, ta.id, "director").map((r) => r.applicationId);
const NOW = Date.now();
const YESTERDAY = NOW - 36 * 3_600_000;

/**
 * An opening with nothing on it: nobody owned, numbered, flagged or mailed,
 * nobody sent to the Director, no Excel Tables rows, a full-hunt day. Every
 * candidate is in New CVs, so nobody waits in tonight's email by accident.
 */
function cleanOpening(ta: User) {
  const o = busiest();
  edit((raw) => {
    for (const a of raw.applications) {
      if (a.openingId !== o.id) continue;
      Object.assign(a, {
        setNumber: null, ownerTaId: null, shortlistedAt: null, stage: "new_cv", isAddOn: false, addedOnAt: null,
        scoopFrom: null, scoopReceivedAt: null, backupForApplicationId: null, jobPostId: null, sourcingChannel: "DA",
      });
    }
    raw.reviewRounds = raw.reviewRounds.filter((r: { openingId: string }) => r.openingId !== o.id);
    raw.linkVault = raw.linkVault.filter((l: { openingId: string }) => l.openingId !== o.id);
    for (const x of raw.assignments ?? []) if (x.openingId === o.id) x.workingStage = "100%";
  });
  repo.setWorkingStage(o.id, ta.id, "100%");
  return o;
}

/** The TA takes them on, then sends them to the Director — the email going out. */
function send(openingId: Id, ta: User, ids: Id[], sentAt = NOW) {
  for (const id of ids) repo.shortlist(id, ta.id);
  const round = repo.openReviewRound({
    openingId, kind: "director", applicationIds: ids, setNumber: 1, sentBy: ta.id, sentTo: "director@career141.com", subject: "test",
  });
  if (sentAt !== NOW) edit((raw) => { raw.reviewRounds.find((r: { id: string }) => r.id === round.id).sentAt = sentAt; });
}

console.log("\neffortRow: only the CVs sent to the Director today, each in its column");
repo.reset();
{
  const ta = repo.users().find((u) => u.role === "ta")!;
  const other = repo.users().find((u) => u.role === "ta" && u.id !== ta.id)!;
  const o = cleanOpening(ta);

  const before = effortRow(o.id, ta);
  eq("no sets yet: SETS is blank", before.sets, null);
  eq("nothing yet: the counted columns are 0", [before.lEffort, before.da, before.l, before.post], [0, 0, 0, 0]);
  eq("nobody backed up: BACK-UP is blank", before.backUp, null);

  // Seven sent today: two WhatsApp applicants, then five on channel L —
  // three hunted through Excel Tables, two who applied to the LinkedIn post.
  const seven = repo.applications(o.id).slice(0, 7);
  const ids = seven.map((a) => a.id);
  const row = (id: string, extra: object) => ({
    id, openingId: o.id, addedBy: ta.id, linkedinUrl: `https://linkedin.com/in/${id}`, name: null, title: null, company: null,
    isEyeMarked: false, phoneNumber: null, phoneSource: null, sourcingChannel: "L", outcome: "contacted", candidateId: null,
    conversationLog: [], createdAt: YESTERDAY, ...extra,
  });
  edit((d) => {
    for (const a of d.applications) if (ids.includes(a.id)) a.sourcingChannel = ids.indexOf(a.id) < 2 ? "DA" : "L";
    d.linkVault.push(
      row("added_today", { createdAt: NOW }),
      row("added_today_untouched", { createdAt: NOW, outcome: "no_contact" }),
      row("moved_today", { outcome: "cv_received", outcomeAt: NOW }),
      row("approached_today", { addedBy: other.id, conversationLog: [{ at: NOW, channel: "whatsapp", note: "hi", by: ta.id }] }),
      row("worked_yesterday", { outcomeAt: YESTERDAY, conversationLog: [{ at: YESTERDAY, channel: "call", note: "", by: ta.id }] }),
      row("someone_elses_today", { addedBy: other.id, createdAt: NOW }),
      // The three hunted: rows from before today, promoted to the opening.
      ...seven.slice(2, 5).map((a, i) => row(`hunted_${i}`, { outcome: "shortlisted", candidateId: a.candidateId })),
    );
  });
  send(o.id, ta, ids);

  const r = effortRow(o.id, ta);
  eq("seven sent in one day are all set 1", r.sets, 1);
  eq("DA counts the WhatsApp CVs sent", r.da, 2);
  eq("L counts the hunted CVs sent", r.l, 3);
  eq("POST counts the LinkedIn-post CVs sent, not adverts put live", r.post, 2);
  eq("L EFFORT: every row added today, contacted or not, and rows worked today", r.lEffort, 4);
  eq("a full-hunt day flags nothing Add-on", r.addOns, null);
  eq("the columns add up to the CVs sent", dayTotal(r), 7);

  const form = new FormData();
  form.set("effort_lEffort", "30");
  form.set("effort_scoop", "3");
  form.set("effort_backUp", "2");
  const typed = effortFromForm(form, r);
  eq("what the TA typed is what is sent", [typed.lEffort, typed.scoop, typed.backUp], [30, 3, 2]);
  eq("the rest keep the records' figures", [typed.sets, typed.da, typed.l, typed.post], [1, 2, 3, 2]);

  // The day's total (28 Sep): the CV columns added up, so a correction moves it.
  eq("typed scoops and backups carry into the total", dayTotal(typed), 12);
  eq("L EFFORT and SETS are not CVs", dayTotal({ lEffort: 40, sets: 3, da: 1 }), 1);
  eq("typed figures read as numbers", dayTotal({ scoop: "4", l: "" }), 4);
  eq("the SETS cell carries the set and the total", setsCell(2, 20), "2 · 20 CVs");
  eq("one CV is one CV", setsCell(1, 1), "1 · 1 CV");
  eq("no set yet: just the total", setsCell(null, 3), "3 CVs");

  // A Follow-up day's fourth column is CVs, not profiles.
  repo.setWorkingStage(o.id, ta.id, "Follow-up");
  eq("a Follow-up day counts the CVs sent in the fourth column", effortRow(o.id, ta).lEffort, 7);
}

console.log("\nonly what went to the Director today, by this TA, once");
repo.reset();
{
  const ta = repo.users().find((u) => u.role === "ta")!;
  const other = repo.users().find((u) => u.role === "ta" && u.id !== ta.id)!;
  const o = cleanOpening(ta);
  const [a1, a2, a3, a4, a5] = repo.applications(o.id).slice(0, 5).map((a) => a.id);
  send(o.id, ta, [a1], YESTERDAY);
  eq("sent yesterday: not today's", dayTotal(effortRow(o.id, ta)), 0);
  send(o.id, other, [a2]);
  eq("another TA's email: theirs", dayTotal(effortRow(o.id, ta)), 0);
  // Put in Director Review without an email (Excel Tables' Add to pipeline):
  // waiting in tonight's table, so counted — and once it goes, still once.
  edit((raw) => Object.assign(raw.applications.find((a: { id: string }) => a.id === a3), { stage: "director_review", ownerTaId: ta.id, lastStageChangedAt: Date.now() }));
  eq("waiting in tonight's email: counted", dayTotal(effortRow(o.id, ta)), 1);
  send(o.id, ta, [a3, a4]);
  eq("after it goes: counted once, beside the others sent", dayTotal(effortRow(o.id, ta)), 2);
  send(o.id, ta, [a5]);
  eq("a second email the same day adds to the day", dayTotal(effortRow(o.id, ta)), 3);
}

console.log("\nthe Director's email is Director Review only (29 Sep)");
repo.reset();
{
  const ta = repo.users().find((u) => u.role === "ta")!;
  const o = cleanOpening(ta);
  const [a1] = repo.applications(o.id).map((a) => a.id);
  const cid = repo.application(a1)!.candidateId;
  // Every question answered, but still with the TA — not yet in Director Review.
  edit((raw) => {
    Object.assign(raw.applications.find((a: { id: string }) => a.id === a1), { stage: "ta_follow_up", ownerTaId: ta.id });
    Object.assign(raw.candidates.find((c: { id: string }) => c.id === cid), {
      currentSalary: "150,000", expectedSalary: "200,000", noticePeriodDays: 30,
    });
  });
  const ready = repo.followUp(a1)?.followUp.state === "complete";
  console.log(`  (follow-up complete in this fixture: ${ready})`);
  eq("a finished follow-up still in the TA's hands is not in the email", shortlistRowsIds(o.id, ta).includes(a1), false);
  eq("nor is it counted in the day", dayTotal(effortRow(o.id, ta)), 0);
  edit((raw) => Object.assign(raw.applications.find((a: { id: string }) => a.id === a1), { stage: "director_review" }));
  eq("moved to Director Review, it is in the email", shortlistRowsIds(o.id, ta).includes(a1), true);
}

console.log("\nSCOOP: of six mailed in by a lead, only the one sent to the Director");
repo.reset();
{
  const ta = repo.users().find((u) => u.role === "ta")!;
  const lead = repo.users().find((u) => u.role === "ta_lead" || u.role === "director")!;
  const o = cleanOpening(ta);
  const six = repo.applications(o.id).slice(0, 6).map((a) => a.id);
  edit((raw) => {
    for (const a of raw.applications) {
      if (six.includes(a.id)) Object.assign(a, { ownerTaId: ta.id, scoopFrom: lead.id, scoopReceivedAt: NOW, stage: "new_cv" });
    }
  });
  eq("six mailed, none sent: SCOOP is blank", effortRow(o.id, ta).scoop, null);
  send(o.id, ta, [six[0]]);
  eq("one of the six sent: SCOOP is 1", effortRow(o.id, ta).scoop, 1);
  eq("and the day is 1 CV", dayTotal(effortRow(o.id, ta)), 1);
}

console.log("\nADD-ONS: of ten add-ons worked, only the three sent to the Director");
repo.reset();
{
  const ta = repo.users().find((u) => u.role === "ta")!;
  const lead = repo.users().find((u) => u.role === "ta_lead" || u.role === "director")!;
  const o = cleanOpening(ta);
  repo.setWorkingStage(o.id, ta.id, "Add-on");
  const ten = repo.applications(o.id).slice(0, 10).map((a) => a.id);
  // Taken on over the day on an Add-on day: flagged, but not yet sent.
  for (const id of ten) repo.shortlist(id, ta.id);
  eq("an Add-on day flags what the TA takes on", ten.every((id) => repo.application(id)!.isAddOn), true);
  edit((raw) => { for (const a of raw.applications) if (ten.includes(a.id)) a.stage = "new_cv"; });
  eq("ten worked, none sent: ADD-ONS is blank", effortRow(o.id, ta).addOns, null);
  send(o.id, ta, ten.slice(0, 3));
  eq("three sent: ADD-ONS is 3", effortRow(o.id, ta).addOns, 3);
  // A CV a lead mailed in stays a scoop, even on an Add-on day.
  const mailed = repo.applications(o.id)[10].id;
  edit((raw) => Object.assign(raw.applications.find((a: { id: string }) => a.id === mailed), { scoopFrom: lead.id, scoopReceivedAt: NOW }));
  send(o.id, ta, [mailed]);
  const r = effortRow(o.id, ta);
  eq("a mailed CV on an Add-on day is a SCOOP", [r.scoop, r.addOns], [1, 3]);
}

console.log("\nan Excel Tables outcome change is dated");
repo.reset();
{
  const o = busiest();
  const ta = repo.users().find((u) => u.role === "ta")!;
  const id = repo.addLink(o.id, "https://linkedin.com/in/dated-row", ta.id, null, "no_contact");
  eq("a new row has no outcome date", repo.linkEntry(id)!.outcomeAt, undefined);
  repo.updateLink(id, { name: "Nimal" });
  eq("editing the name does not date it", repo.linkEntry(id)!.outcomeAt, undefined);
  repo.updateLink(id, { outcome: "cv_received" });
  eq("changing the outcome dates it", typeof repo.linkEntry(id)!.outcomeAt, "number");
}

console.log("\nExcel Tables: add-on links, tagged and filtered");
repo.reset();
{
  const { readLinkFilters } = await import("@/lib/linkViews");
  const ta = repo.users().find((u) => u.role === "ta")!;
  const o = cleanOpening(ta);
  const plain = repo.addLink(o.id, "https://linkedin.com/in/plain-day", ta.id, "Nimal Perera");
  eq("added on a 100% day: not an add-on", !!repo.linkEntry(plain)!.isAddOn, false);
  repo.setWorkingStage(o.id, ta.id, "Add-on");
  const extra = repo.addLink(o.id, "https://linkedin.com/in/addon-day", ta.id, "Kasun Silva", "contacted");
  eq("added on an Add-on day: an add-on", repo.linkEntry(extra)!.isAddOn, true);
  repo.setLinkAddOn(plain, true);
  eq("tagged by hand", repo.linkEntry(plain)!.isAddOn, true);
  repo.setLinkAddOn(plain, false);
  eq("and untagged", repo.linkEntry(plain)!.isAddOn, false);

  const rows = repo.linkVault(o.id);
  eq("both rows are in the table", rows.length, 2);
  eq("Add-ons shows the add-on", rows.filter((r) => r.isAddOn).map((r) => r.id), [extra]);
  eq("an old ?view=addons link still filters add-ons", readLinkFilters({ view: "addons" }).addons, true);
  eq("an old ?view=shortlisted link opens Interested", readLinkFilters({ view: "shortlisted" }).status, "interested");

  // Joining the pipeline keeps the tag, so it is counted under ADD-ONS.
  repo.updateLink(extra, { outcome: "shortlisted" });
  const res = repo.linkToApplication(extra, ta.id);
  const app = res.ok ? repo.application(res.applicationId) : undefined;
  eq("an add-on link becomes an add-on application", app?.isAddOn, true);
}

console.log("\neffortBucket: each CV in one column — backup, scoop, add-on, then its source");
{
  const base = {
    id: "a", openingId: "o", jobPostId: null, candidateId: "c", sourcingChannel: "L", isAddOn: false,
    addedOnAt: null, backupForApplicationId: null, scoopFrom: null, scoopReceivedAt: null,
  } as unknown as Parameters<typeof effortBucket>[0];
  const hunted = new Set(["c"]);
  const none = new Set<string>();
  eq("a backup that is also an add-on is a backup", effortBucket({ ...base, backupForApplicationId: "p", isAddOn: true }, hunted), "backUp");
  eq("a mailed scoop that is also an add-on is a scoop", effortBucket({ ...base, scoopFrom: "lead", isAddOn: true }, hunted), "scoop");
  eq("an add-on from Excel Tables is an add-on", effortBucket({ ...base, isAddOn: true }, hunted), "addOns");
  eq("L in Excel Tables is headhunted", effortBucket(base, hunted), "l");
  eq("L not in Excel Tables applied to the LinkedIn post", effortBucket(base, none), "post");
  eq("WhatsApp is DA", effortBucket({ ...base, sourcingChannel: "DA" }, none), "da");
  eq("an emailed CV filed against an advert is POST", effortBucket({ ...base, sourcingChannel: "E", jobPostId: "jp" }, none), "post");
  eq("a database pick is in no column", effortBucket({ ...base, sourcingChannel: "SCOOP" }, none), null);
}

console.log("\nshortlisting while someone is at interview makes a backup");
repo.reset();
{
  const ta = repo.users().find((u) => u.role === "ta")!;
  const o = cleanOpening(ta);
  const [lead, before, after] = repo.applications(o.id).slice(0, 3).map((a) => a.id);
  repo.shortlist(before, ta.id);
  eq("nobody at interview: not a backup", repo.application(before)!.backupForApplicationId, null);
  edit((d) => { d.applications.find((a: { id: string }) => a.id === lead).stage = "interview"; });
  repo.shortlist(after, ta.id);
  eq("someone at interview: a backup for them", repo.application(after)!.backupForApplicationId, lead);
  send(o.id, ta, [after]);
  eq("sent: counted in BACK-UP", effortRow(o.id, ta).backUp, 1);
  eq("the TA can take the tag off", repo.setBackup(after, false), true);
  eq("off", repo.application(after)!.backupForApplicationId, null);
  eq("or put it back on by hand", repo.setBackup(before, true) && repo.application(before)!.backupForApplicationId, lead);
  edit((d) => { d.applications.find((a: { id: string }) => a.id === lead).stage = "new_cv"; });
  eq("nobody to back up: refused", repo.setBackup(after, true), false);
}

console.log("\nthe sent email: what the TA left on screen, added up the same way");
{
  const base = {
    date: "28 Sept", assignee: "Sanduni", hundredOrFollowUp: "100%", lEffort: 40, sets: 4 as number | string | null,
    da: 2, scoop: null, l: 0, post: 3, addOns: null, backUp: 1,
  };
  const form = new FormData();
  form.set("effort_sets", "4");
  form.set("effort_l", "2");
  form.set("effort_date", "29 Sept");
  const sent = effortFromForm(form, base);
  eq("SETS typed as text is kept", sent.sets, "4");
  eq("a corrected column moves the total", dayTotal(sent), 8);
  eq("the date can be corrected", sent.date, "29 Sept");
  const html = eodEmailHtml({ rows: [], effort: sent, senderName: "Sanduni" });
  eq("the email's SETS cell is the set and the day's CVs", html.includes(">4 · 8 CVs<"), true);
  eq("L EFFORT goes out on its own, not in the total", html.includes(">40<"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
