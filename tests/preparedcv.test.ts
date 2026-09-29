/**
 * The Prepared CV box and the replaced CV (29 Sep).
 *
 * The box prints only what the desk holds — no "NOT DISCLOSED" nobody typed —
 * at one font size, wrapped to one width, where the TA dragged it. A replaced
 * CV only fills what is empty.
 */
import { boxContent, boxItems, clampBox, layoutBox, noticeText, roughMeasure, BOX } from "@/lib/preparedCv";
import { annotationItems, stampCareer141Box } from "@/lib/pdf";
import { fillBlanksOnly, CV_FILE_KEYS } from "../convex/lib/fillBlanks";
import { TABLES, sameValue } from "../convex/ta/model/tables";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nonly what is held goes in the box");
const empty = boxContent({ notes: [], answers: {} }, { currentSalary: null, expectedSalary: null, noticePeriodDays: null }, null);
eq("nothing held → header only", boxItems(empty), ["CAREER141 CANDIDATE"]);
eq("no NOT DISCLOSED invented", annotationItems({ currentSalary: "", expectedSalary: "", notes: [] }).join("|").includes("DISCLOSED"), false);
eq("a typed 'Not disclosed' is an answer and prints", annotationItems({ currentSalary: "Not disclosed", notes: [] })[1], "CURRENT SALARY - Not disclosed");
const held = boxContent(
  { notes: ["Matched from the database, fit 80", "Driving licence: Yes", ">Can join after bonus"], answers: { q1: "Colombo 05" } },
  { currentSalary: "LKR 250,000", expectedSalary: null, noticePeriodDays: null, noticePeriod: "1 month" },
  { followUpQuestions: [{ id: "q1", label: "Current location" }] },
);
eq("salary kept, empty expected left out", boxItems(held).slice(1, 3), ["CURRENT SALARY - LKR 250,000", "NOTICE PERIOD - 1 month"]);
eq("notes without system lines, plus the job's own answers", held.notes, ["Driving licence: Yes", "Can join after bonus", "Current location: Colombo 05"]);
eq("notice from days", noticeText({ noticePeriodDays: 30 }), "30 Days");
eq("zero days is Immediate", noticeText({ noticePeriodDays: 0 }), "Immediate");
eq("words win over days", noticeText({ noticePeriodDays: 30, noticePeriod: "immediate" }), "Immediate");

console.log("\none width, one font size");
const long = ["CAREER141 CANDIDATE", `- ${"Handled the regional distributor network across the Western and Southern provinces ".repeat(4)}`];
const lay = layoutBox(long, roughMeasure);
eq("fixed width", lay.width, BOX.width);
eq("long note wraps onto more lines", lay.lines.length > 4, true);
eq("every line fits the width", lay.lines.every((l) => roughMeasure(l.text, l.bold ? BOX.headerSize : BOX.bodySize, l.bold) <= BOX.width - BOX.padding * 2), true);
eq("taller, not smaller: height follows the lines", lay.height, BOX.padding * 2 + lay.lines.length * BOX.lineHeight + 4);
eq("a word wider than the box is cut, not overflowed", layoutBox(["H", "x".repeat(200)], roughMeasure).lines.every((l) => roughMeasure(l.text, 8.5, false) <= BOX.width - 16), true);
eq("a dragged spot is kept on the page", clampBox({ x: 900, y: -40 }, { width: 260, height: 100 }, { width: 595, height: 842 }), { x: 325, y: 10 });

console.log("\nthe stamp: the TA's spot, the fixed size");
{
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const base = Buffer.from(await doc.save());
  const none = await stampCareer141Box(base, { notes: [] });
  eq("nothing held → no box, PDF unchanged", [none.box, none.bytes.length], [null, base.length]);
  const s = await stampCareer141Box(base, { currentSalary: "LKR 250,000", notes: ["x ".repeat(300)] }, { x: 40, y: 60 });
  eq("placed where the TA put it", [s.box?.x, s.box?.y], [40, 60]);
  eq("width stays fixed with long notes", s.box?.width, BOX.width);
  const short = await stampCareer141Box(base, { currentSalary: "LKR 250,000", notes: [] }, { x: 40, y: 60 });
  eq("more text is a taller box", (s.box?.height ?? 0) > (short.box?.height ?? 0), true);
}

console.log("\na replaced CV only fills blanks");
const current = { expectedSalary: undefined, taExpectedSalaryText: "LKR 300k", noticePeriodDays: 30, skills: ["Sales"], languages: [], location: null, fullName: "Nimal Perera" };
const kept = fillBlanksOnly(current, {
  expectedSalary: 250000, noticePeriod: "2 months", skills: [], languages: ["English"], location: "Kandy", fullName: "N Perera", rawTextKey: "k2", status: "new",
}, CV_FILE_KEYS);
eq("a typed salary stops the CV's number", "expectedSalary" in kept, false);
eq("notice in days stops notice in words", "noticePeriod" in kept, false);
eq("an empty list never clears one", "skills" in kept, false);
eq("empty fields are filled", [kept.languages, kept.location], [["English"], "Kandy"]);
eq("a name on file stays", "fullName" in kept, false);
eq("the file's own text always updates", kept.rawTextKey, "k2");

console.log("\nthe end-of-day attachment says what the email says");
{
  const { boxOverrides, eodDetailChanges } = await import("@/lib/eod-format");
  const row = {
    no: 1, name: "A", age: "", notice: "", notes: [">Total Experience - 10yr", ">Available now"], currentCompany: "", currentDesignation: "",
    currentRemuneration: "Not disclosed", expectedRemuneration: "Open to discuss", applicationId: "a1",
  };
  eq("nothing changed on the email → the record, no table defaults", boxOverrides(eodDetailChanges(row, row)), {});
  const edited = { ...row, expectedRemuneration: "LKR 300,000", notice: "2 months" };
  eq("changed fields reach the box", boxOverrides(eodDetailChanges(row, edited)), { expectedSalary: "LKR 300,000", noticePeriod: "2 months" });
  const held = { currentSalary: null, expectedSalary: null, noticePeriod: null, notes: ["Available now"] };
  const items = annotationItems({ ...held, ...boxOverrides(eodDetailChanges(row, edited)) });
  eq("the untouched 'Not disclosed' is not printed", items.some((l) => /DISCLOSED|Not disclosed/i.test(l)), false);
  eq("the edited expected salary is", items.includes("EXPECTED SALARY - LKR 300,000"), true);
}

console.log("\nthe saved spot is stored and read back");
{
  const m = TABLES.applications;
  const row = { id: "a1", openingId: "o1", candidateId: "c1", stage: "ta_follow_up", answers: {}, notes: [], sourcingChannel: "E", preparedCvBox: { x: 40, y: 60 }, lastStageChangedAt: 1 };
  const doc = await m.toDoc(row as never, { get: async () => null, now: 1 } as never, false);
  eq("stored", doc.taPreparedCvBox, { x: 40, y: 60 });
  const back = m.fromDoc({ ...doc, _id: "a1", _creationTime: 1 } as never) as Record<string, unknown>;
  eq("read back", sameValue(back.preparedCvBox, { x: 40, y: 60 }), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
