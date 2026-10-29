/**
 * The Database search as a conversation (5 Oct): each message adds to the
 * search, and a later message wins where it changes a number, a place or a title.
 */
import { conversationText, parseConversation, parseQuery, resultsKeyOf, searchParamsOf, turnCounts, turnsOf, yearsBand, type Vocabulary } from "@/lib/query";
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

console.log("\nthe results page keeps the list on screen (28 Oct)");
const key = (sp: Record<string, string | string[] | undefined>) => resultsKeyOf(sp);
eq("a reply keeps the key", key({ q: "java developer" }), key({ q: "java developer\nin Colombo" }));
eq("paging, a profile and a level keep it", key({ q: "java" }), key({ q: "java", page: "2", candidate: "c1", lvl: ["Senior"], below: "1", msg: "x" }));
eq("a new first message is a new search", key({ q: "java" }) === key({ q: "react" }), false);
eq("a mode is a new search", key({ q: "java" }) === key({ q: "java", mode: "boolean" }), false);
eq("an opening is a new search", key({ q: "java" }) === key({ q: "java", for: "o1" }), false);
eq("an edited chip is a new search", key({ q: "java" }) === key({ q: "java", edited: "1", minExp: "3" }), false);
const href = searchParamsOf({ q: "java\nin Colombo", lvl: ["Senior", "Mid"], page: "2", candidate: "c1", below: "1" }, ["page", "candidate"]);
eq("links keep the address, less what they replace", href.toString(), "q=java%0Ain+Colombo&lvl=Senior&lvl=Mid&below=1");
eq("an address with no chips gains none", [...searchParamsOf({ q: "java" }).keys()], ["q"]);

console.log("\nthe chat's counts (29 Oct)");
eq("a first message has only today's count", turnCounts(undefined, 1, 142), [142]);
eq("earlier counts are carried, today's is last", turnCounts("142,38", 3, 12), [142, 38, 12]);
eq("an unknown count stays unknown", turnCounts(",38", 3, 12), [null, 38, 12]);
eq("a count list that does not fit is not trusted", turnCounts("142", 3, 12), [null, null, 12]);
eq("junk is not a count", turnCounts("a,5", 3, 12), [null, 5, 12]);
eq("counts do not make a different search", resultsKeyOf({ q: "java", n: "25" }), resultsKeyOf({ q: "java\nin Colombo", n: "25,10" }));

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
