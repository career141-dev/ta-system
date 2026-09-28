/**
 * The end-of-day L-sheet line (the desk, 28 Sep): every column but BACK-UP
 * comes from the records — L EFFORT and L from Excel Tables, POST from the
 * adverts, SCOOP from mailed scoops, ADD-ONS from the Add-on flag.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-effort-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { effortRow, effortFromForm } = await import("@/lib/eod");
const { dayTotal, setsCell } = await import("@/lib/eod-format");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const dbFile = () => path.join(tmp, ".data", "db.json");
const busiest = () => [...repo.openings()].sort((x, y) => repo.applications(y.id).length - repo.applications(x.id).length)[0];

console.log("\neffortRow: everything but BACK-UP comes from the records");
repo.reset();
{
  const o = busiest();
  const ta = repo.users().find((u) => u.role === "ta")!;
  const other = repo.users().find((u) => u.role === "ta" && u.id !== ta.id)!;
  const now = Date.now();
  const YESTERDAY = now - 36 * 3_600_000;
  // A clean opening: nobody owned or numbered, no Excel Tables rows, no adverts
  // put live today, nobody flagged, a full-hunt day.
  const raw = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of raw.applications) {
    if (a.openingId !== o.id) continue;
    Object.assign(a, { setNumber: null, ownerTaId: null, shortlistedAt: null, stage: "new_cv", isAddOn: false, addedOnAt: null, scoopReceivedAt: null });
  }
  raw.linkVault = raw.linkVault.filter((l: { openingId: string }) => l.openingId !== o.id);
  for (const p of raw.jobPosts) if (p.openingId === o.id) p.postedAt = YESTERDAY;
  for (const x of raw.assignments ?? []) if (x.openingId === o.id) x.workingStage = "100%";
  fs.writeFileSync(dbFile(), JSON.stringify(raw));
  repo.setWorkingStage(o.id, ta.id, "100%");

  const before = effortRow(o.id, ta);
  eq("no sets yet: SETS is blank", before.sets, null);
  eq("nothing yet: the counted columns are 0", [before.lEffort, before.da, before.l, before.post], [0, 0, 0, 0]);
  eq("BACK-UP starts blank for the TA to type", before.backUp, null);

  // Seven shortlisted today: two WhatsApp applicants, five headhunted (L).
  const ids = repo.applications(o.id).slice(0, 7).map((a) => a.id);
  const d = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of d.applications) if (ids.includes(a.id)) a.sourcingChannel = ids.indexOf(a.id) < 2 ? "DA" : "L";
  // Excel Tables: what this TA worked today, and what does not count.
  const row = (id: string, extra: object) => ({
    id, openingId: o.id, addedBy: ta.id, linkedinUrl: `https://linkedin.com/in/${id}`, name: null, title: null, company: null,
    isEyeMarked: false, phoneNumber: null, phoneSource: null, sourcingChannel: "L", outcome: "contacted", candidateId: null,
    conversationLog: [], createdAt: YESTERDAY, ...extra,
  });
  d.linkVault.push(
    row("added_today", { createdAt: now }),
    row("added_today_untouched", { createdAt: now, outcome: "no_contact" }),
    row("moved_today", { outcome: "cv_received", outcomeAt: now }),
    row("approached_today", { addedBy: other.id, conversationLog: [{ at: now, channel: "whatsapp", note: "hi", by: ta.id }] }),
    row("worked_yesterday", { outcomeAt: YESTERDAY, conversationLog: [{ at: YESTERDAY, channel: "call", note: "", by: ta.id }] }),
    row("someone_elses_today", { addedBy: other.id, createdAt: now }),
  );
  // One advert put live today by this TA, one by another.
  const posts = d.jobPosts.filter((p: { openingId: string }) => p.openingId === o.id);
  if (posts[0]) Object.assign(posts[0], { postedAt: now, assignedTaId: ta.id });
  if (posts[1]) Object.assign(posts[1], { postedAt: now, assignedTaId: other.id });
  fs.writeFileSync(dbFile(), JSON.stringify(d));
  for (const id of ids) repo.shortlist(id, ta.id);

  const r = effortRow(o.id, ta);
  eq("seven sent in one day are all set 1", r.sets, 1);
  eq("DA counts today's WhatsApp shortlists", r.da, 2);
  eq("L counts today's headhunted shortlists", r.l, 5);
  eq("L EFFORT: added and contacted, outcome moved, or approach logged today", r.lEffort, 3);
  eq("POST: this TA's adverts put live today", r.post, posts[0] ? 1 : 0);
  eq("a full-hunt day flags nothing Add-on", r.addOns, null);
  eq("the records' CVs for the total", r.recorded, { cvs: 7, scoop: 0 });

  const form = new FormData();
  form.set("effort_lEffort", "30");
  form.set("effort_scoop", "3");
  form.set("effort_backUp", "2");
  const sent = effortFromForm(form, r);
  eq("what the TA typed is what is sent", [sent.lEffort, sent.scoop, sent.backUp], [30, 3, 2]);
  eq("the rest keep the records' figures", [sent.sets, sent.da, sent.l], [1, 2, 5]);

  // The day's total (28 Sep): each CV once, plus scoops typed over the mailed ones.
  eq("the total is the day's CVs plus WhatsApp scoops", dayTotal(sent, sent.recorded), 10);
  eq("scoops that came by mail are not counted twice", dayTotal({ scoop: 2 }, { cvs: 7, scoop: 2 }), 7);
  eq("no records: just the typed scoops", dayTotal({ scoop: "4" }), 4);
  eq("the SETS cell carries the set and the total", setsCell(2, 20), "2 · 20 CVs");
  eq("one CV is one CV", setsCell(1, 1), "1 · 1 CV");
  eq("no set yet: just the total", setsCell(null, 3), "3 CVs");

  // A Follow-up day's fourth column is CVs, not profiles.
  repo.setWorkingStage(o.id, ta.id, "Follow-up");
  eq("a Follow-up day counts CVs in the fourth column", effortRow(o.id, ta).lEffort, 7);
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

console.log("\neffortRow: SCOOP counts scoops mailed to the TA today");
repo.reset();
{
  const o = busiest();
  const ta = repo.users().find((u) => u.role === "ta")!;
  const other = repo.users().find((u) => u.role === "ta" && u.id !== ta.id);
  const director = repo.users().find((u) => u.role === "director")!;
  const [a1, a2, a3, a4] = repo.applications(o.id).slice(0, 4).map((a) => a.id);
  const raw = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of raw.applications) {
    if (a.openingId !== o.id) continue;
    a.scoopFrom = null; a.scoopReceivedAt = null;
    if (a.id === a1 || a.id === a2) { a.ownerTaId = ta.id; a.scoopFrom = director.id; a.scoopReceivedAt = Date.now(); }
    // Yesterday's scoop is yesterday's.
    if (a.id === a3) { a.ownerTaId = ta.id; a.scoopFrom = director.id; a.scoopReceivedAt = Date.now() - 36 * 3_600_000; }
    // Another TA's scoop is theirs.
    if (a.id === a4 && other) { a.ownerTaId = other.id; a.scoopFrom = director.id; a.scoopReceivedAt = Date.now(); }
  }
  fs.writeFileSync(dbFile(), JSON.stringify(raw));
  eq("today's mailed scoops, this TA's only", effortRow(o.id, ta).scoop, 2);

  const none = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of none.applications) if (a.openingId === o.id) a.scoopReceivedAt = null;
  fs.writeFileSync(dbFile(), JSON.stringify(none));
  eq("none mailed: SCOOP stays blank for the TA to type", effortRow(o.id, ta).scoop, null);
}

console.log("\neffortRow: ADD-ONS counts CVs flagged Add-on today");
repo.reset();
{
  const o = busiest();
  const ta = repo.users().find((u) => u.role === "ta")!;
  const other = repo.users().find((u) => u.role === "ta" && u.id !== ta.id);
  const [a1, a2, a3, a4, a5] = repo.applications(o.id).slice(0, 5).map((a) => a.id);
  const raw = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of raw.applications) {
    if (a.openingId !== o.id) continue;
    a.isAddOn = false; a.addedOnAt = null;
    if (a.id === a1 || a.id === a2) { a.ownerTaId = ta.id; a.isAddOn = true; a.addedOnAt = Date.now(); }
    // Flagged yesterday: yesterday's add-on.
    if (a.id === a3) { a.ownerTaId = ta.id; a.isAddOn = true; a.addedOnAt = Date.now() - 36 * 3_600_000; }
    // Shortlisted today but not flagged: not an add-on.
    if (a.id === a4) { a.ownerTaId = ta.id; a.shortlistedAt = Date.now(); }
    // Another TA's add-on is theirs.
    if (a.id === a5 && other) { a.ownerTaId = other.id; a.isAddOn = true; a.addedOnAt = Date.now(); }
  }
  fs.writeFileSync(dbFile(), JSON.stringify(raw));
  eq("today's Add-on flags, this TA's only", effortRow(o.id, ta).addOns, 2);

  const none = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of none.applications) if (a.openingId === o.id) { a.isAddOn = false; a.addedOnAt = null; }
  fs.writeFileSync(dbFile(), JSON.stringify(none));
  eq("none flagged: ADD-ONS is blank", effortRow(o.id, ta).addOns, null);
}

console.log("\nshortlisting on an Add-on day flags the CV Add-on");
repo.reset();
{
  const o = busiest();
  const ta = repo.users().find((u) => u.role === "ta")!;
  const raw = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of raw.applications) {
    if (a.openingId !== o.id) continue;
    Object.assign(a, { setNumber: null, ownerTaId: null, shortlistedAt: null, stage: "new_cv", isAddOn: false, addedOnAt: null });
  }
  fs.writeFileSync(dbFile(), JSON.stringify(raw));
  const [first, second] = repo.applications(o.id).slice(0, 2).map((a) => a.id);
  repo.setWorkingStage(o.id, ta.id, "100%");
  repo.shortlist(first, ta.id);
  eq("a 100% day: not an add-on", repo.application(first)!.isAddOn, false);
  repo.setWorkingStage(o.id, ta.id, "Add-on");
  repo.shortlist(second, ta.id);
  eq("an Add-on day: flagged", repo.application(second)!.isAddOn, true);
  eq("and counted in ADD-ONS", effortRow(o.id, ta).addOns, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
