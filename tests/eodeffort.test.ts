/**
 * The end-of-day L-sheet line: SETS and DA come from the records (the desk,
 * 25 Sep), SCOOP from mailed scoops (27 Sep) and ADD-ONS from the Add-on flag
 * (28 Sep). L EFFORT, L, POST and BACK-UP are the TA's to type.
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

console.log("\neffortRow: SETS and DA are counted, the typed columns start blank");
repo.reset();
{
  const o = [...repo.openings()].sort((x, y) => repo.applications(y.id).length - repo.applications(x.id).length)[0];
  const ta = repo.users().find((u) => u.role === "ta")!;
  // A clean opening: nobody owned, nobody numbered.
  const raw = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of raw.applications) if (a.openingId === o.id) { a.setNumber = null; a.ownerTaId = null; a.shortlistedAt = null; a.stage = "new_cv"; }
  fs.writeFileSync(dbFile(), JSON.stringify(raw));

  const before = effortRow(o.id, ta);
  eq("no sets yet: SETS is blank", before.sets, null);
  eq("no shortlists yet: DA is 0", before.da, 0);

  // Seven shortlisted today, two of them WhatsApp applicants.
  const ids = repo.applications(o.id).slice(0, 7).map((a) => a.id);
  const channels = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of channels.applications) if (ids.includes(a.id)) a.sourcingChannel = ids.indexOf(a.id) < 2 ? "DA" : "L";
  fs.writeFileSync(dbFile(), JSON.stringify(channels));
  for (const id of ids) repo.shortlist(id, ta.id);

  const row = effortRow(o.id, ta);
  eq("seven sent in one day are all set 1", row.sets, 1);
  eq("DA counts today's WhatsApp shortlists", row.da, 2);
  eq(
    "the typed columns start blank",
    [row.lEffort, row.scoop, row.l, row.post, row.addOns, row.backUp],
    [null, null, null, null, null, null],
  );

  const form = new FormData();
  form.set("effort_lEffort", "30");
  form.set("effort_scoop", "3");
  form.set("effort_l", "12");
  form.set("effort_post", "1");
  form.set("effort_addOns", "");
  form.set("effort_backUp", "2");
  const sent = effortFromForm(form, row);
  eq(
    "what the TA typed is what is sent",
    [sent.lEffort, sent.scoop, sent.l, sent.post, sent.addOns, sent.backUp],
    [30, 3, 12, 1, null, 2],
  );
  eq("SETS and DA keep the records' figures when not typed over", [sent.sets, sent.da], [1, 2]);

  // The day's total beside the set (the desk, 27 Sep): DA 2 + scoop 3 + L 12 + post 1 + back-up 2.
  eq("the day's total adds DA, scoop, L, post, add-ons and back-up", dayTotal(sent), 20);
  eq("L EFFORT and SETS are not in the total", dayTotal({ lEffort: 30, sets: 2 }), 0);
  eq("typed figures count as they are typed", dayTotal({ da: "1", scoop: "", l: "4" }), 5);
  eq("the SETS cell carries the set and the total", setsCell(2, 20), "2 · 20 CVs");
  eq("one CV is one CV", setsCell(1, 1), "1 · 1 CV");
  eq("no set yet: just the total", setsCell(null, 3), "3 CVs");
}

console.log("\neffortRow: SCOOP counts scoops mailed to the TA today");
repo.reset();
{
  const o = [...repo.openings()].sort((x, y) => repo.applications(y.id).length - repo.applications(x.id).length)[0];
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
  const o = [...repo.openings()].sort((x, y) => repo.applications(y.id).length - repo.applications(x.id).length)[0];
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
  const row = effortRow(o.id, ta);
  eq("today's Add-on flags, this TA's only", row.addOns, 2);
  eq("BACK-UP still starts blank for the TA to type", row.backUp, null);

  const none = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  for (const a of none.applications) if (a.openingId === o.id) { a.isAddOn = false; a.addedOnAt = null; }
  fs.writeFileSync(dbFile(), JSON.stringify(none));
  eq("none flagged: ADD-ONS is blank", effortRow(o.id, ta).addOns, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
