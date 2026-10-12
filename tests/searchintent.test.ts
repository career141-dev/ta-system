/**
 * Conversational database search V1: intent memory sits above the existing
 * engine, so these tests stay deterministic and do not call a model.
 */
import { appendSearchTurn, intentToEngineHints, readSearchIntent } from "@/lib/searchIntent";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const has = (l: string, list: string[], item: string) => eq(l, list.some((x) => x.toLowerCase().includes(item.toLowerCase())), true);

console.log("\nvague searches become intent plus questions");
const vague = readSearchIntent(["Find an HR manager for manufacturing"]);
eq("target role read", vague.targetRole, "HR manager");
has("domain appears as an unknown to clarify", vague.unknowns, "domain_priority");
eq("asks non-blocking clarifications", vague.clarifyingQuestions.length > 0, true);

console.log("\nlater turns update the memory");
const refined = readSearchIntent(["Find an HR manager for manufacturing", "Actually FMCG, not banking"]);
has("later exclusion becomes dealbreaker", refined.dealBreakers, "banking");
eq("role is kept", refined.targetRole, "HR manager");

console.log("\nmust-have and nice-to-have are separate hints");
const mixed = readSearchIntent(["Need a finance analyst. Must have Power BI and SQL. Nice to have SAP."]);
has("must have Power BI", mixed.mustHave, "Power BI");
has("nice to have SAP", mixed.niceToHave, "SAP");
const hints = intentToEngineHints(mixed);
has("must-have becomes strict hint", hints.mustHave, "Power BI");
has("nice-to-have becomes boost hint", hints.niceToHave, "SAP");

console.log("\ndealbreakers are remembered");
const avoid = readSearchIntent(["Find a sales lead", "avoid Dialog"]);
has("avoid company recorded", avoid.dealBreakers, "Dialog");

console.log("\nclarification chips append turns");
const appended = appendSearchTurn("Find an HR manager for manufacturing", "Location is flexible; nearby candidates are okay.");
eq("turn appended on its own line", appended, "Find an HR manager for manufacturing\nLocation is flexible; nearby candidates are okay.");
const answered = readSearchIntent(appended);
has("answer updates soft preferences", answered.softPreferences, "nearby");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
