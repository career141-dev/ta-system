/**
 * The Database search as a conversation (5 Oct): each message adds to the
 * search, and a later message wins where it changes a number, a place or a title.
 */
import { conversationText, parseConversation, parseQuery, turnsOf, yearsBand, type Vocabulary } from "@/lib/query";
import { searchKindOf } from "@/lib/searchIntent";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const vocab: Vocabulary = {
  titles: ["Software Engineer", "Senior Software Engineer", "Team Lead"],
  skills: ["React", "Java"],
  industries: [],
  cities: ["Dhaka", "Colombo"],
  employers: ["Dialog", "Brandix"],
  qualifications: [],
  languages: [],
  nationalities: [],
};

console.log("\nthe messages");
eq("one per line, blanks dropped", turnsOf("Senior Software Engineer in Dhaka\n\n with 5 years \n"), ["Senior Software Engineer in Dhaka", "with 5 years"]);
eq("one request for the engine", conversationText("Senior Software Engineer in Dhaka.\nwith 5 years"), "Senior Software Engineer in Dhaka. with 5 years");
eq("a single message reads as before", parseConversation("Senior Software Engineer in Dhaka with 5 years", vocab).criteria, parseQuery("Senior Software Engineer in Dhaka with 5 years", vocab).criteria);

console.log("\nthe earlier messages are kept");
const two = parseConversation("Senior Software Engineer in Dhaka\nwith 5 years experience", vocab).criteria;
eq("place from the first", two.locations, ["Dhaka"]);
eq("years from the second", two.minExperience, 5);
eq("title from the first", two.titles.length > 0, true);

console.log("\na later message changes, or adds");
const three = parseConversation("Senior Software Engineer in Dhaka with 5 years\nat least 8 years\nin Colombo instead\nknows React\nnot from Dialog", vocab).criteria;
eq("years replaced", three.minExperience, 8);
eq("place replaced", three.locations, ["Colombo"]);
eq("skill added", three.skills.includes("React"), true);
eq("company ruled out", three.excludeEmployers, ["Dialog"]);
eq("title still there", three.titles.length > 0, true);

console.log("\nyears: a bare figure is a band, not a floor (28 Oct)");
const yrs = (q: string) => {
  const c = parseQuery(q, vocab).criteria;
  return [c.minExperience, c.maxExperience];
};
eq("bare 2 years", yrs("accountant 2 years"), [2, 4]);
eq("bare 5 years", yrs("accountant with 5 years experience"), [5, 8]);
eq("bare 10 years", yrs("manager 10 years"), [10, 15]);
eq("at least stays open", yrs("accountant at least 5 years"), [5, null]);
eq("5+ stays open", yrs("accountant 5+ years"), [5, null]);
eq("up to is a ceiling only", yrs("accountant up to 3 years"), [null, 3]);
eq("a range is as written", yrs("accountant 3-5 years"), [3, 5]);
eq("yearsBand", [yearsBand(1), yearsBand(2), yearsBand(5), yearsBand(10)], [3, 4, 8, 15]);
const later = parseConversation("accountant 5 years\nat least 8 years", vocab).criteria;
eq("a later 'at least' drops the earlier ceiling", [later.minExperience, later.maxExperience], [8, null]);
const ceiling = parseConversation("accountant 5 years\nup to 6 years", vocab).criteria;
eq("a later ceiling keeps the floor", [ceiling.minExperience, ceiling.maxExperience], [5, 6]);

console.log("\nwhat was typed (28 Oct)");
eq("a role", searchKindOf(["Senior Accountant in Colombo"], true).kind, "role");
eq("a keyword list with a lead", searchKindOf(["find profiles with SAP, IFRS and Big 4"], false), { kind: "keywords", keywords: ["SAP", "IFRS", "Big 4"] });
eq("a bare comma list", searchKindOf(["SAP, IFRS, Big 4"], false).kind, "keywords");
eq("a place and years is not a list", searchKindOf(["accountant, in Colombo, 5 years"], true).kind, "role");
eq("a name", searchKindOf(["Nimal Perera"], false).kind, "name");
eq("a known title is not a name", searchKindOf(["Senior Accountant"], true).kind, "role");
eq("lower-case words are not taken for a name", searchKindOf(["senior accountant"], false).kind, "role");
eq("a long paste is a JD", searchKindOf(["x ".repeat(250)], true).kind, "job_description");
eq("a short JD with headings", searchKindOf(["Accountant. Responsibilities: monthly close, bank recs, payroll review and audit support for three entities. Requirements: ACA, 3-5 years, SAP."], true).kind, "job_description");
eq("a conversation is a role", searchKindOf(["Nimal Perera", "in Colombo"], false).kind, "role");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
