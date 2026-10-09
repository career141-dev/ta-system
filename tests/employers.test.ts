/**
 * Database search by company and as a conversation (9 Oct).
 *
 * Employers: where a candidate has worked (lib/employers), whether that is the
 * company a search asked for, and how the score ranks it. The owner's rule is
 * that a named company keeps only people who worked there, now or before, with
 * the people there now first.
 *
 * Conversation: "software engineer", then "in Bangladesh", then "working at
 * ABC" is one search. The model is asked with the messages numbered; the
 * network is faked, so nothing leaves the machine.
 */
import {
  careerOf,
  describeEmployerHit,
  employerMatch,
  employersInText,
  employersOf,
  employersTextOf,
  excludedByEmployer,
} from "../convex/lib/employers";
import { scoreCandidateAgainstRequirements } from "../convex/cvs/cvScoring";
import {
  conversationMessage,
  conversationReply,
  extractConversationRequirements,
  fallbackRequirements,
} from "../convex/lib/jdParser";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nwhere a candidate worked");
const row = { currentEmployer: "Dialog Axiata PLC", jobHistory: [{ title: "Clerk", company: "Old Row Ltd" }] };
const resume = {
  jobHistory: [
    { title: "HR Executive", company: "Dialog Axiata PLC", startDate: "2021-03", endDate: "Present" },
    { title: "HR Assistant", company: "Brandix Lanka (Pvt) Ltd", startDate: "2017", endDate: "2021" },
    { title: "Intern", company: "Brandix Lanka", startDate: "2016", endDate: "2017" },
  ],
};
eq("the résumé's career wins when it has one", careerOf(row, resume).length, 3);
eq("the row's career when the résumé has none", careerOf(row, { jobHistory: [] })[0].company, "Old Row Ltd");
eq("current first, each company once", employersOf(row, resume), ["Dialog Axiata PLC", "Brandix Lanka (Pvt) Ltd"]);
eq("the index text", employersTextOf(row, resume), "Dialog Axiata PLC | Brandix Lanka (Pvt) Ltd");
eq("nobody named: no text at all", employersTextOf({}, null), undefined);

console.log("\nis this the company asked for");
const hr = { currentEmployer: "Dialog Axiata PLC", jobHistory: resume.jobHistory };
eq("Dialog finds Dialog Axiata PLC, now", employerMatch(["Dialog"], hr)?.when, "current");
eq("Brandix finds an earlier job", employerMatch(["Brandix"], hr)?.when, "past");
eq("with the years worked there", employerMatch(["Brandix"], hr)?.years, "2017–2021");
eq("now outranks before", (employerMatch(["Dialog"], hr)?.score ?? 0) > (employerMatch(["Brandix"], hr)?.score ?? 0), true);
eq("currently at: an earlier job does not count", employerMatch(["Brandix"], hr, "current"), null);
eq("a company never worked at", employerMatch(["MAS Holdings"], hr), null);
eq("generic employers never match", employerMatch(["Self employed"], { currentEmployer: "Self Employed" }), null);
eq("from the index text when the career is not loaded", employerMatch(["Brandix"], { currentEmployer: "Dialog Axiata PLC", employersText: "Dialog Axiata PLC | Brandix Lanka (Pvt) Ltd" })?.when, "past");
eq("the line a TA reads", describeEmployerHit(employerMatch(["Dialog"], hr)!), "Works at Dialog Axiata PLC (2021–now)");
eq("not from Dialog: someone there now is left out", excludedByEmployer(["Dialog"], hr), true);
eq("not from Brandix: someone who left is kept", excludedByEmployer(["Brandix"], hr), false);

console.log("\ncompanies in a sentence, without a model");
eq("in Dialog is a company", employersInText("HR personnel in Dialog").employers, ["Dialog"]);
eq("in Bangladesh is a place", employersInText("Software engineer in Bangladesh").employers, []);
eq("working at ABC", employersInText("software engineer. in Bangladesh. working at ABC Holdings").employers, ["ABC Holdings"]);
eq("a full stop after the name is not part of it", employersInText("working at ABC. in Colombo instead").employers, ["ABC"]);
eq("currently at narrows to now", employersInText("accountants currently at John Keells").scope, "current");
eq("not from rules a company out", employersInText("Team Lead not from Dialog"), { employers: [], excludeEmployers: ["Dialog"], scope: "any" });
eq("the words-only reading keeps the company", fallbackRequirements("HR personnel in Dialog").requirements.employers, ["Dialog"]);

console.log("\nthe score");
const req = {
  title: "HR Executive", alternativeTitles: ["HR Officer"], occupationSynonyms: [], requiredSkills: [], preferredSkills: [],
  minYearsExperience: null, industry: null, seniority: null, location: null, education: null, summary: "HR personnel at Dialog",
  keywords: [], languages: [], clientCompany: null, clientContactEmail: null, salaryRange: null,
  employers: ["Dialog"], employerScope: "any" as const,
};
const atDialogNow = { _id: "a", currentJobTitle: "HR Executive", currentEmployer: "Dialog Axiata PLC", jobHistory: resume.jobHistory };
const leftDialog = {
  _id: "b", currentJobTitle: "HR Executive", currentEmployer: "Hayleys PLC",
  jobHistory: [{ title: "HR Executive", company: "Hayleys PLC", startDate: "2022", endDate: "Present" }, { title: "HR Officer", company: "Dialog Axiata", startDate: "2018", endDate: "2022" }],
};
const neverDialog = { _id: "c", currentJobTitle: "HR Executive", currentEmployer: "Hayleys PLC", jobHistory: [{ title: "HR Executive", company: "Hayleys PLC", startDate: "2019", endDate: "Present" }] };
const [now, before, never] = [atDialogNow, leftDialog, neverDialog].map((cv, i) => scoreCandidateAgainstRequirements(cv as never, req as never, i));
eq("the title is read from currentJobTitle", now.titleScore > 0, true);
eq("at Dialog now ranks above someone who left", now.overallScore > before.overallScore, true);
eq("someone who left ranks above someone never there", before.overallScore > never.overallScore, true);
eq("the reason names the company", before.reason.startsWith("Worked at Dialog Axiata (2018–2022)."), true);
eq("no employer hit for someone never there", never.employerHit, null);
{
  // A past title counts: an Office Manager who used to be an HR Executive.
  const moved = { _id: "d", currentJobTitle: "Office Manager", pastJobTitles: ["HR Executive"] };
  const plain = { _id: "e", currentJobTitle: "Office Manager" };
  const noCompany = { ...req, employers: [] };
  eq("a past title counts towards the title", scoreCandidateAgainstRequirements(moved as never, noCompany as never, 0).titleScore > scoreCandidateAgainstRequirements(plain as never, noCompany as never, 1).titleScore, true);
}
{
  // "Everyone at Dialog" names no role; the people there are still the answer.
  const anyone = { ...req, title: "Position", alternativeTitles: [] };
  const driver = { _id: "f", currentJobTitle: "Driver", currentEmployer: "Dialog Axiata PLC" };
  eq("no role named: a Dialog employee is not scored zero", scoreCandidateAgainstRequirements(driver as never, anyone as never, 0).overallScore > 0, true);
}

console.log("\nthe conversation, read as one search");
const turns = ["software engineer", "in Bangladesh", "working at ABC"];
eq("the messages are numbered, oldest first", conversationMessage(turns), "1. software engineer\n2. in Bangladesh\n3. working at ABC");
{
  const r = conversationReply('Here it is: {"title":"Software Engineer","location":"Bangladesh","employers":["ABC","ABC Holdings"],"employerScope":"current","clientCompany":null}', turns);
  eq("the reply's title", r?.title, "Software Engineer");
  eq("the reply's place", r?.location, "Bangladesh");
  eq("the reply's companies", r?.employers, ["ABC", "ABC Holdings"]);
  eq("working at, with no word for now, means now or before", r?.employerScope, "any");
}
eq(
  "currently at means now",
  conversationReply('{"title":"Accountant","employers":["John Keells"],"employerScope":"current"}', ["accountants", "currently at John Keells"])?.employerScope,
  "current",
);
eq("a company alone is still a search", conversationReply('{"employers":["Dialog"]}', ["people at Dialog"])?.employers, ["Dialog"]);
eq("an unreadable reply is no reading", conversationReply("I cannot help with that.", turns), null);

process.env.C141_APP_INTERNAL_URL = "http://app:3000";
process.env.C141_CLAUDE_BRIDGE_SECRET = "a-long-enough-test-secret";
process.env.OPENROUTER_API_KEY = "sk-or-test-not-a-real-key";
delete process.env.NVIDIA_API_KEY;
const sent: string[] = [];
let deepseekAnswer = "{}";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/internal/claude")) {
    return new Response(JSON.stringify({ ok: false, reason: "busy" }), { status: 503 });
  }
  const body = JSON.parse(String(init?.body));
  sent.push(body.messages?.[1]?.content ?? "");
  return new Response(JSON.stringify({
    id: "x", object: "chat.completion", created: 0, model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: deepseekAnswer } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

deepseekAnswer = '{"title":"Software Engineer","location":"Colombo","employers":["ABC"],"summary":"Software engineers in Colombo who work or worked at ABC"}';
{
  const r = await extractConversationRequirements(["software engineer in Dhaka", "working at ABC", "in Colombo instead"]);
  eq("the model was sent every message, numbered", sent[0], "1. software engineer in Dhaka\n2. working at ABC\n3. in Colombo instead");
  eq("its one reading is the answer", [r.requirements.location, r.requirements.employers], ["Colombo", ["ABC"]]);
}
deepseekAnswer = "not json at all";
{
  const r = await extractConversationRequirements(["HR personnel", "in Dialog"]);
  eq("every model down: the words of all the messages", r.usage.model, "regex-fallback");
  eq("and the company is still read", r.requirements.employers, ["Dialog"]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
