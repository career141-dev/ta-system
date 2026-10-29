/**
 * Suggestions by Claude (src/lib/claudeSourcing readHeadhunt). The rule under
 * test: a person is suggested only when a search returned their profile —
 * never because Claude's answer named them — and never someone at the client
 * or someone the desk already has.
 */
import { deskSignals, headhuntPrompt, readHeadhunt } from "@/lib/claudeSourcing";
import type { SourcingSpec } from "@/lib/sourcing";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const spec: SourcingSpec = {
  title: "Senior Executive - NVOCC", clientName: "Ocean Leader", clientCompanyNames: ["Ocean Leader Pvt Ltd"],
  jdText: "4-6 years sea freight documentation", locations: ["Colombo"], targetNationalities: [], targetGender: null,
  salaryNote: "LKR 150-200k", targetEmployers: [], alreadyKnown: ["linkedin.com/in/already-known"],
};

const links = [
  { title: "Kajan Thiyagamoorthy - Documentation Executive - SWEN Container Line", url: "https://lk.linkedin.com/in/kajan-thiyagamoorthy-a7b139179" },
  { title: "Hashan De Mel - Senior Executive - Ceyline", url: "https://www.linkedin.com/in/hashandemel/" },
  { title: "Nimal P - Ocean Leader", url: "https://lk.linkedin.com/in/nimal-ocean" },
  { title: "Old friend", url: "https://lk.linkedin.com/in/already-known" },
  { title: "SWEN Container Line | LinkedIn", url: "https://lk.linkedin.com/company/swen" },
];
const stream = (answer: unknown, extra: Record<string, unknown> = {}) =>
  [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "a" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: `Links: ${JSON.stringify(links)}\n\nsummary` }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "b" } }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: typeof answer === "string" ? answer : JSON.stringify(answer), ...extra }),
  ].join("\n");

const person = (link: string, company: string, fit = "strong", concern = "", more: Record<string, unknown> = {}) => ({ name: "X", link, headline: "Documentation Executive", company, location: "Colombo", years: 5, level: "match", sameFunction: true, fit, why: "NVOCC documentation", concern, ...more });

console.log("\nwho Claude may suggest");
{
  const r = readHeadhunt(
    stream([
      person("https://www.linkedin.com/in/kajan-thiyagamoorthy-a7b139179/", "SWEN Container Line", "strong", "years not shown"),
      person("https://www.linkedin.com/in/hashandemel", "Ceyline", "possible", "none"),
      person("https://www.linkedin.com/in/made-up-person", "Somewhere"),
      person("https://lk.linkedin.com/in/nimal-ocean", "Ocean Leader"),
      person("https://lk.linkedin.com/in/already-known", "Maersk"),
      person("https://lk.linkedin.com/company/swen", "SWEN"),
    ]),
    spec,
    1,
    1000,
  );
  eq("two people kept, best first", r.suggestions.map((s) => s.linkedinUrl), ["https://www.linkedin.com/in/kajan-thiyagamoorthy-a7b139179", "https://www.linkedin.com/in/hashandemel"]);
  eq("the search's address, not Claude's spelling", r.suggestions[0].sourceUrl, "https://lk.linkedin.com/in/kajan-thiyagamoorthy-a7b139179");
  eq("strong is priority, possible is screen", r.suggestions.map((s) => s.tier), ["priority", "screen"]);
  eq("an honest concern is kept, 'none' is not a concern", r.suggestions.map((s) => s.concern), ["years not shown", null]);
  eq("a person no search returned, and a company page, are not suggested", r.rejected, 2);
  eq("searches and profiles are counted", [r.credits, r.scanned], [2, 4]);
  eq("the searches Claude ran are listed, so the page does not say 0", r.queries, ["a", "b"]);
  eq("fewer than six is said so", r.note, "only_2_fit");
}
{
  const r = readHeadhunt(stream([person("https://lk.linkedin.com/in/hashandemel", "Ceyline")]), { ...spec, clientCompanyNames: [] }, 2);
  eq("the round is recorded", r.suggestions[0].round, 2);
}

console.log("\nthe accuracy bar (28 Oct)");
{
  const r = readHeadhunt(
    stream([
      person("https://www.linkedin.com/in/kajan-thiyagamoorthy-a7b139179/", "SWEN Container Line"),
      person("https://www.linkedin.com/in/hashandemel", "Ceyline", "strong", "", { level: "far_above", years: 28 }),
      person("https://lk.linkedin.com/in/nimal-ocean", "Maersk", "strong", "", { sameFunction: false }),
    ]),
    { ...spec, clientCompanyNames: [] },
    1,
  );
  eq("far too senior and a different function are dropped, not flagged", r.suggestions.map((s) => s.linkedinUrl), ["https://www.linkedin.com/in/kajan-thiyagamoorthy-a7b139179"]);
  eq("and counted as ruled out", r.rejected, 2);
  const unknown = readHeadhunt(stream([person("https://lk.linkedin.com/in/nimal-ocean", "", "possible", "", { headline: "" })]), { ...spec, clientCompanyNames: [] }, 1);
  eq("no title and no company is nothing to judge", unknown.suggestions.length, 0);
  const asText = readHeadhunt(stream([person("https://lk.linkedin.com/in/nimal-ocean", "Maersk", "strong", "", { sameFunction: "true" })]), { ...spec, clientCompanyNames: [] }, 1);
  eq("\"true\" as text still counts", asText.suggestions.length, 1);
}

console.log("\nlearning from the desk (28 Oct)");
{
  eq("nothing chosen yet adds nothing", deskSignals({}), "");
  const prompt = headhuntPrompt({ ...spec, picked: ["Shipping Executive, at Hirdaramani, 4 years"], notSelected: ["Supply Chain Manager, Garment Services, 28 years"] }, "Sri Lanka");
  eq("picked CVs reach the prompt", prompt.includes("PEOPLE THE RECRUITERS PICKED") && prompt.includes("at Hirdaramani"), true);
  eq("turned-down people reach the prompt", prompt.includes("TURNED DOWN") && prompt.includes("28 years"), true);
  eq("the five must-haves are asked for", ["FUNCTION", "LEVEL", "YEARS", "INDUSTRY", "LOCATION"].every((w) => prompt.includes(w)), true);
}

console.log("\nwhen Claude could not do it");
{
  eq("no answer at all", readHeadhunt('{"type":"system"}', spec, 1).error, "claude_no_answer");
  const limit = readHeadhunt(stream("Claude AI usage limit reached", { is_error: true, subtype: "error_during_execution" }), spec, 1);
  eq("a usage limit is a failure, so the old search runs", [limit.error, limit.suggestions.length], ["claude_failed", 0]);
  eq("an answer that is not a list suggests nobody", readHeadhunt(stream("Sorry, I could not find anyone."), spec, 1).suggestions.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
