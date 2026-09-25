/**
 * The end-of-day L-sheet line (the desk, 25 Sep): SETS and DA come from the
 * records, every other column is the TA's to type.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-effort-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { effortRow, effortFromForm } = await import("@/lib/eod");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const dbFile = () => path.join(tmp, ".data", "db.json");

console.log("\neffortRow: only SETS and DA are counted");
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
  eq("SETS is the set the latest CV went into", row.sets, 2);
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
  eq("SETS and DA keep the records' figures when not typed over", [sent.sets, sent.da], [2, 2]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
