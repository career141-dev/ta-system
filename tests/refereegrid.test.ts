import { applyPaste, changeCount, diffRows, emptyRow, parsePastedBlock, toTsv, type GridRow, type GridValues } from "@/lib/refereeGrid";

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}\n  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(actual)}`);
  }
}

// ── Pasting from Excel ──────────────────────────────────────────────────────
eq("tabs and new lines; Excel's last new line is not a row",
  parsePastedBlock("Asiri\tSuranga\t0768\tHas a contact\r\nHemas\tAmila\t0773\tNo answer\r\n"),
  [["Asiri", "Suranga", "0768", "Has a contact"], ["Hemas", "Amila", "0773", "No answer"]]);
eq("a quoted cell keeps its tab, new line and quotes",
  parsePastedBlock('A\t"He said ""call back""\nlater"\tx'),
  [["A", 'He said "call back"\nlater', "x"]]);
eq("empty cells stay in place", parsePastedBlock("A\t\t\tD"), [["A", "", "", "D"]]);
eq("copy out quotes what needs it", toTsv([["A", "b\tc"], ['say "hi"', "x\ny"]]), 'A\t"b\tc"\n"say ""hi"""\t"x\ny"');
eq("copy then paste is the same block", parsePastedBlock(toTsv([["a", "b\tc"], ["d\ne", 'f"g']])), [["a", "b\tc"], ["d\ne", 'f"g']]);

let n = 0;
const key = () => `k${n++}`;
const row = (k: string, v: Partial<GridValues> = {}, id?: string): GridRow => ({ ...emptyRow(k), ...v, ...(id ? { id } : {}) });

const pasted = applyPaste([row("a"), row("b"), row("c")], { r: 1, c: 0 }, parsePastedBlock("C1\tR1\t071\tNo answer\nC2\tR2\t072\tWill call back\nC3\tR3\t073\tWrong number"), key);
eq("a 3×4 block from row 2 fills rows 2–4", pasted.slice(1).map((r) => [r.company, r.referral, r.contactNumber, r.feedback]),
  [["C1", "R1", "071", "No answer"], ["C2", "R2", "072", "Will call back"], ["C3", "R3", "073", "Wrong number"]]);
eq("pasting past the last row adds rows", pasted.length, 4);
eq("the row above the paste is untouched", pasted[0].company, "");

const wide = applyPaste([row("a")], { r: 0, c: 2 }, [["071", "No answer", "extra", "more"]], key);
eq("columns past Feedback are dropped", [wide[0].contactNumber, wide[0].feedback, wide[0].company], ["071", "No answer", ""]);

const locked = applyPaste([row("a", {}, "x1"), row("b")], { r: 0, c: 0 }, [["One"], ["Two"]], key, (r) => !r.id);
eq("a row the viewer may not edit is left alone", [locked[0].company, locked[1].company], ["", "Two"]);

// ── What Save sends ────────────────────────────────────────────────────────
const saved = new Map<string, GridValues>([
  ["s1", { company: "Asiri", referral: "Suranga", contactNumber: "0768", feedback: "Has a contact" }],
  ["s2", { company: "Hemas", referral: "Amila", contactNumber: "0773", feedback: "No answer" }],
  ["s3", { company: "Nawaloka", referral: "Nalaka", contactNumber: "", feedback: "Overseas" }],
]);
const diff = diffRows(saved, [
  row("s1", { company: "Asiri", referral: "Suranga", contactNumber: "0768", feedback: "Has a contact" }, "s1"),
  row("s2", { company: "Hemas", referral: "Amila", contactNumber: "0773", feedback: "Will call back" }, "s2"),
  // s3 removed from the sheet
  row("n1", { company: "Medihelp" }),
  row("n2"),
]);
eq("new rows with any text are added; blank ones are not", diff.add.map((a) => a.company), ["Medihelp"]);
eq("a changed row is an update", diff.update.map((u) => [u.id, u.feedback]), [["s2", "Will call back"]]);
eq("a row taken off the sheet is removed", diff.remove, ["s3"]);
eq("three changes", changeCount(diff), 3);

const back = diffRows(saved, [
  row("s1", { company: "Asiri ", referral: "Suranga", contactNumber: "0768", feedback: "Has a contact" }, "s1"),
  row("s2", {}, "s2"),
  row("s3", { company: "Nawaloka", referral: "Nalaka", contactNumber: "", feedback: "Overseas" }, "s3"),
]);
eq("a row typed back to what was saved is not a change", back.update, []);
eq("a saved row cleared to blank is removed", back.remove, ["s2"]);
eq("nothing to save on a fresh sheet", changeCount(diffRows(saved, [...saved].map(([id, v]) => row(id, v, id)))), 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
