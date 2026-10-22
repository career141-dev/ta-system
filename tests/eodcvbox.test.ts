/**
 * The Director's email and the CV's box say the same thing (the desk, 29 Sep).
 * What the TA corrects on the end-of-day email — salaries, notice, their own
 * notes — is saved to the candidate when it goes; the box carries the notice;
 * and a box already printed on a CV is covered whole, not just its heading.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-eodbox-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { eodDetailChanges, shortlistRowFor } = await import("@/lib/eod");
const { formatNoteHtml, stripNoteFormatting } = await import("@/lib/eod-format");
const { noticePeriodToDays } = await import("@/lib/answered");
const { buildAnnotationLines, printedBoxExtent, stampPdfWithCareer141Box } = await import("@/lib/pdf");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
import type { ShortlistRow } from "@/lib/eod";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const base: ShortlistRow = {
  no: 1, name: "Nimal Perera", age: "34", notice: "30 days",
  notes: [">Total Experience - 8yr", ">Currently at Acme", ">Strong in retail"],
  currentCompany: "Acme", currentDesignation: "Brand Manager",
  currentRemuneration: "LKR 250,000", expectedRemuneration: "LKR 300,000", applicationId: "a1",
};

console.log("\nwhat the TA changed");
eq("nothing changed: nothing to save", eodDetailChanges(base, { ...base }), null);
eq("name and age are the email's own", eodDetailChanges(base, { ...base, name: "N. Perera", age: "35" }), null);
eq("a corrected company and designation are saved (9 Oct)", eodDetailChanges(base, { ...base, currentCompany: "Hayleys PLC", currentDesignation: "Senior Brand Manager" }), { patch: { currentTitle: "Senior Brand Manager", currentEmployer: "Hayleys PLC" }, notes: null });
eq("a cleared company is saved as none", eodDetailChanges(base, { ...base, currentCompany: "  " })?.patch, { currentEmployer: null });
eq("a new expected salary", eodDetailChanges(base, { ...base, expectedRemuneration: "LKR 350,000" }), { patch: { expectedSalary: "LKR 350,000" }, notes: null });
eq("a new notice, as said and in days", eodDetailChanges(base, { ...base, notice: "2 months" })?.patch, { noticePeriod: "2 months", noticePeriodDays: noticePeriodToDays("2 months") });
eq("the house lines are not the TA's notes", eodDetailChanges(base, { ...base, notes: [">Strong in retail"] }), null);
eq("a note the TA added is saved, without the house lines", eodDetailChanges(base, { ...base, notes: [...base.notes, ">Can join in 2 weeks"] })?.notes, ["Strong in retail", "Can join in 2 weeks"]);

console.log("\nsaved to the candidate");
{
  const app = repo.applications(repo.openings()[0].id)[0];
  const change = eodDetailChanges(base, { ...base, expectedRemuneration: "LKR 350,000", notice: "Immediate" })!;
  repo.saveReviewDetails(app.id, app.candidateId, change.notes, change.patch);
  const c = repo.candidate(app.candidateId)!;
  eq("the candidate has the email's figures", [c.expectedSalary, c.noticePeriod, c.noticePeriodDays], ["LKR 350,000", "Immediate", 0]);
  const notesBefore = repo.application(app.id)!.notes;
  repo.saveReviewDetails(app.id, app.candidateId, null, {});
  eq("notes left alone when the TA did not change them", repo.application(app.id)!.notes, notesBefore);
  const moved = eodDetailChanges(base, { ...base, currentCompany: "Hayleys PLC", currentDesignation: "Senior Brand Manager" })!;
  repo.saveReviewDetails(app.id, app.candidateId, moved.notes, moved.patch);
  const after = repo.candidate(app.candidateId)!;
  eq("the candidate has the email's company and designation", [after.currentEmployer, after.currentTitle], ["Hayleys PLC", "Senior Brand Manager"]);
  eq("and the next email reads them", [shortlistRowFor(app, after, 1).currentCompany, shortlistRowFor(app, after, 1).currentDesignation], ["Hayleys PLC", "Senior Brand Manager"]);
  const updatedApp = { ...app, notes: ["Note: first", "Note: second", "New follow-up note"] };
  const updatedCandidate = { ...after, totalExperienceYears: 1, currentEmployer: "Example employer" };
  const emailNotes = shortlistRowFor(updatedApp, updatedCandidate, 1).notes;
  eq("the email includes new notes beyond its former four-line cutoff", emailNotes,
    [">Total Experience - 1yr", ">Currently at Example employer", ">Note: first", ">Note: second", ">New follow-up note"]);
  eq("all TA notes from the CV box also appear in the email", updatedApp.notes.every(note => emailNotes.includes(`>${note}`)), true);
}

console.log("\nthe box on the CV");
eq("carries the notice", buildAnnotationLines({ currentSalary: "LKR 1", expectedSalary: "LKR 2", noticePeriod: "2 months", notes: [] }).includes("NOTICE PERIOD - 2 months"), true);
{
  // An old box printed at x 400: heading at 700, three lines under it, and
  // text elsewhere on the page that is not part of it.
  const items = [
    { str: "Nimal Perera", transform: [1, 0, 0, 1, 50, 760], width: 80 },
    { str: "CAREER141 CANDIDATE", transform: [1, 0, 0, 1, 400, 700], width: 110 },
    { str: "Profile summary", transform: [1, 0, 0, 1, 50, 690], width: 90 },
    { str: "CURRENT SALARY - LKR 100,000", transform: [1, 0, 0, 1, 400, 687], width: 150 },
    { str: "EXPECTED SALARY - LKR 120,000", transform: [1, 0, 0, 1, 400, 674], width: 155 },
    { str: "NOTICE PERIOD - 30 Days", transform: [1, 0, 0, 1, 400, 661], width: 120 },
    { str: "Experience", transform: [1, 0, 0, 1, 400, 500], width: 60 },
  ];
  const e = printedBoxExtent(items, 1);
  eq("reaches down past its last line (661), not just the heading", 700 + 14 - e.height <= 661 - 4, true);
  eq("stops at the box, not the next section (500)", 700 + 14 - e.height > 600, true);
  eq("as wide as its longest line", e.width >= 155, true);
}
{
  // End to end: a CV with a printed box is stamped without error and changes.
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("CAREER141 CANDIDATE", { x: 400, y: 700, size: 9, font });
  page.drawText("CURRENT SALARY - LKR 100,000", { x: 400, y: 687, size: 8, font });
  page.drawText("NOTICE PERIOD - 30 Days", { x: 400, y: 674, size: 8, font });
  const before = await doc.save();
  const after = await stampPdfWithCareer141Box(Buffer.from(before), { currentSalary: "LKR 250,000", expectedSalary: "LKR 300,000", noticePeriod: "2 months", notes: [] });
  eq("a new box is drawn", after.length > before.length, true);
}

console.log("\nnote highlighting and formatting");
eq("stripNoteFormatting cleans highlight and bold", stripNoteFormatting(">==Immediate joiner== (**Relocation ready**)"), ">Immediate joiner (Relocation ready)");
eq("formatNoteHtml renders <mark> with inline style", formatNoteHtml(">==Immediate joiner==").includes('<mark style="background-color:#fef08a'), true);
eq("formatNoteHtml renders <b> for bold", formatNoteHtml(">**Top performer**").includes("<b>Top performer</b>"), true);
eq("formatNoteHtml escapes special chars safely", formatNoteHtml("><script>alert(1)</script>").includes("<script>"), false);

console.log("\nhighlighting stays in the email");
{
  const row = { no: 1, name: "A", age: "", notice: "", notes: [">Immediate joiner"], currentCompany: "", currentDesignation: "", currentRemuneration: "", expectedRemuneration: "", applicationId: "a1" };
  eq("highlighting a note alone is no change to save", eodDetailChanges(row, { ...row, notes: [">==Immediate joiner=="] }), null);
  eq("a new highlighted note is saved as plain words", eodDetailChanges(row, { ...row, notes: [">Immediate joiner", ">**Top performer**"] })?.notes, ["Immediate joiner", "Top performer"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
