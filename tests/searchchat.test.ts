/**
 * The Database search as a conversation (5 Oct): each message adds to the
 * search, and a later message wins where it changes a number, a place or a title.
 */
import { conversationText, parseConversation, parseQuery, turnsOf, type Vocabulary } from "@/lib/query";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
