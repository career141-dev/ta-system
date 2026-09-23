/**
 * The referee parser that runs when the model cannot (src/lib/refereeExtractor).
 * A CV upload files these against a real candidate, so a block read wrongly
 * puts a stranger's phone number on somebody's record.
 */
import { parseRefereesRegex } from "@/lib/refereeExtractor";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nreferees, read from the text of a CV");
{
  const cv = `WORK EXPERIENCE
Software Engineer, Virtusa, 2019 - 2024

REFERENCES
Mr. Nimal Perera
Senior Manager
Hatton National Bank PLC
Tel: +94 77 123 4567
Email: nimal.perera@hnb.lk

Dr. Samanthi Silva
Senior Lecturer
University of Moratuwa
0112 650 301
samanthi@uom.lk`;
  const refs = parseRefereesRegex(cv);
  eq("both referees are found, and nothing from the job history", refs.length, 2);
  eq("the name keeps its honorific", refs[0].name, "Mr. Nimal Perera");
  eq("the email belongs to the right one", [refs[0].email, refs[1].email], ["nimal.perera@hnb.lk", "samanthi@uom.lk"]);
  eq("the phone is kept as written", refs[0].contactNo, "+94 77 123 4567");
  eq("designation and company are not swapped", [refs[1].designation, refs[1].company], ["Senior Lecturer", "University of Moratuwa"]);
}

console.log("\na CV that names nobody");
{
  eq("no references section means none are invented", parseRefereesRegex("SKILLS\nJava, SQL\n\nEDUCATION\nBSc"), []);
  eq("empty text is no referees", parseRefereesRegex(""), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
