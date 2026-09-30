/**
 * A referee is a person (30 Sep): the CV reading returned a Security Manager's
 * duty bullets as seven referees. These are those lines, word for word.
 */
import { isPlausibleReferee, looksLikePersonName } from "../convex/lib/refereeCheck";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nduty bullets are not referees");
for (const line of [
  "Took part in active Battle Operation Duties northern area in Sri Lanka.",
  "Delivered regular training sessions on safety and SOPs for security guards",
  "Established and enforced Standard Operating Procedures (SOPs) for:",
  "Screened daily incident/security reports and addressed any abnormalities promptly.",
  "Monitored and maintained CCTV and intruder alarm systems across all facilities.",
  "Monitored and controlled CAPEX and OPEX using SAP",
  "Handled local and international procurement operations:",
]) {
  eq(line.slice(0, 40), isPlausibleReferee({ name: line, company: "Somewhere" }), false);
}

console.log("\nreal referees are kept");
eq("name + phone", isPlausibleReferee({ name: "Nimal Perera", contactNo: "+94 77 123 4567" }), true);
eq("initials and a title", isPlausibleReferee({ name: "Mr. K. A. Perera", designation: "General Manager" }), true);
eq("rank", isPlausibleReferee({ name: "Col. S. Fernando", company: "Sri Lanka Army" }), true);
eq("Dr.", looksLikePersonName("Dr. Anura Silva"), true);
eq("a name with nothing to reach or place them is not a referee", isPlausibleReferee({ name: "Nimal Perera" }), false);
eq("empty", isPlausibleReferee({ name: "", email: "a@b.com" }), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
