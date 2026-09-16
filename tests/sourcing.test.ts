import { parseExclusions, plain, profileFacts, rankFields } from "../src/lib/sourcing";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("reading a ranked line");
const seven = rankFields("[3] | 82 | priority | Jane Perera | Senior Accountant at Hayleys | CIMA, 6 years at Hayleys | NONE");
ok("seven fields with a score", seven?.score === 82 && seven.tier === "priority" && seven.name === "Jane Perera");
const six = rankFields("3 | screen | Jane | Accountant | reason | concern");
ok("the older six-field form still reads, without a score", six?.score === null && six.tier === "screen" && six.concern === "concern");
ok("a line that is not a row is ignored", rankFields("Here are the candidates:") === null);

console.log("\nplain text");
ok("markdown bold is removed", plain("**Sri Lanka-based.** 3 years") === "Sri Lanka-based. 3 years");

console.log("\nfacts from the search result, never from the model");
ok("company from 'Name - Title - Company'", profileFacts({ title: "Kasun Silva - Senior Engineer - WSO2", snippets: [] }).company === "WSO2");
ok("company from 'Title at Company'", profileFacts({ title: "Kashmetha M. - Software Engineer at Axiata Digital Labs", snippets: [] }).company === "Axiata Digital Labs");
ok("location from the snippet", profileFacts({ title: "A - B", snippets: ["Experience: WSO2 · Location: Colombo · 500+ connections"] }).location === "Colombo");
ok("nothing invented when absent", profileFacts({ title: "Name only", snippets: ["no facts"] }).company === null);

console.log("\nreading the reject list, whatever form the model uses");
const pipe = parseExclusions("3 | different discipline\n[5] | too junior\nINDEX | REASON", 10);
ok("the asked-for pipe form", pipe.size === 2 && pipe.get(3) === "different discipline" && pipe.get(5) === "too junior");
const dash = parseExclusions("[0] Reject - aviation pricing, not freight\n\n[11] Reject - level far below", 20);
ok("'[n] Reject - reason', as DeepSeek wrote it", dash.size === 2 && dash.get(11) === "level far below", JSON.stringify([...dash]));
ok("a kept line is not a rejection", parseExclusions("[2] Keep - right work\n4: Reject: wrong sector", 10).size === 1);
ok("NONE rejects nobody", parseExclusions("NONE", 10).size === 0);
ok("an index past the list is ignored", parseExclusions("[40] | wrong", 10).size === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
