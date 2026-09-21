import { buildJd, extractFromText } from "@/lib/intake";

let passed = 0;
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${g}, want ${w}`); }
};

// The notes from the 21 Sep test opening, as saved.
const notes = "package around 3L, located in SriLanka\n\nFrom the recording:\nHybrid method preferred.";

console.log("reading notes");
const e = extractFromText(notes);
eq("3L is LKR 300,000", e.salaryMin, 300_000);
eq("3.5 lakhs", extractFromText("salary 3.5 lakhs").salaryMin, 350_000);
eq("a range in L", [extractFromText("2L - 3L").salaryMin, extractFromText("2L - 3L").salaryMax], [200_000, 300_000]);
eq("an L inside a word is not money", extractFromText("5 Level manager").salaryMin, null);
eq("the sentences become the notes", e.clientNotes, "package around 3L, located in SriLanka\nHybrid method preferred.");
eq("bullets stay requirements, not notes", extractFromText("CIMA needed\n- CIMA\n- 5 years").clientNotes, "CIMA needed");

console.log("\nthe template");
const jd = buildJd({ ...e, title: "Senior software engineer", locations: ["Sri Lanka"] }, "Gajani 2nd company");
eq("no placeholder requirements", jd.includes("To be completed"), false);
eq("no 'None recorded'", jd.includes("None recorded"), false);
eq("the notes are in it", jd.includes("Hybrid method preferred."), true);
eq("the package is a figure", jd.includes("**Package** LKR 300,000"), true);
eq("an empty brief has no empty sections", buildJd(extractFromText(""), "X").includes("###"), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
