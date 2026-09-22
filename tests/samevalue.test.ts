/**
 * What a save counts as a change (convex/ta/model/tables.ts). `sameValue`
 * decides what is written, so it is exact on text; `looselySame` is only for
 * the "changed by someone else" check (review of PR #10, 22 September).
 */
import { looselySame, sameValue } from "../convex/ta/model/tables";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nwhat a save writes");
eq("a name corrected only in case is a change", sameValue("nimal perera", "Nimal Perera"), false);
eq("a salary with its commas removed is a change", sameValue("250,000", "250000"), false);
eq("the same text is not", sameValue("Nimal", "Nimal"), true);
eq("absent and null are the same", sameValue(undefined, null), true);
eq("lists compare item by item", sameValue(["A", "b"], ["A", "B"]), false);

console.log("\nthe conflict check");
eq("a value only reformatted is not someone else's edit", looselySame("250,000", "250000"), true);
eq("… nor one only re-cased", looselySame("Colombo ", "colombo"), true);
eq("a real change still is", looselySame("250,000", "300,000"), false);
eq("non-text falls back to the exact rule", looselySame(3, 4), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
