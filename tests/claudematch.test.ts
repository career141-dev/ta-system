/**
 * Database-match reasons by Claude (src/lib/claudeMatch). The rules under
 * test: nothing that names or reaches a candidate goes into the prompt; an
 * answer counts only for a person who was asked about; and the switch is off
 * unless both the setting and the subscription token are there.
 */
import { claudeMatchOn, matchLine, matchPrompt, pickByScore, readMatch, readMatchText, type MatchJob } from "@/lib/claudeMatch";
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const person: Candidate = {
  id: "cand_1", fullName: "Nimali Perera", email: "nimali@example.com", phone: "+94 77 123 4567",
  linkedinUrl: "https://www.linkedin.com/in/nimali-perera", location: "Colombo", nationality: "Sri Lankan",
  age: 31, gender: "female", currentEmployer: "Hayleys", currentTitle: "Senior Accountant", totalExperienceYears: 6,
  educationDegree: "ACCA", educationInstitution: "ACCA", qualifications: null, englishLevel: 8, languages: [],
  skills: ["IFRS", "Payroll", "SAP", "Tax"], industries: ["Manufacturing"], noticePeriodDays: 30,
  currentSalary: "LKR 250k", expectedSalary: "LKR 300k", cvFileName: "nimali.pdf",
  workHistory: [
    { title: "Senior Accountant", employer: "Hayleys", fromYear: 2021, toYear: null },
    { title: "Accountant", employer: "John Keells", fromYear: 2018, toYear: 2021 },
  ],
  createdAt: 0,
};
const job: MatchJob = {
  title: "Finance Manager", industry: "Manufacturing", jdText: "Lead month-end close and IFRS reporting.",
  req: { minYears: 5, requiredSkills: ["IFRS"], qualitativeMusts: [], locations: ["Colombo"] },
};

console.log("\nwhat Claude is shown");
{
  const line = matchLine(1, person);
  const prompt = matchPrompt(job, [line]);
  // Years as the hard rules count them: the record or the career, whichever is longer.
  eq("the line carries the work", [line.includes("Senior Accountant @ Hayleys"), /\| (\d+) yrs/.test(line) && Number(/\| (\d+) yrs/.exec(line)![1]) >= 6, line.includes("before: Accountant")], [true, true, true]);
  const leaks = ["Nimali", "Perera", "nimali@example.com", "123 4567", "linkedin.com", "Sri Lankan", "LKR"].filter((s) => prompt.includes(s));
  eq("no name, contact, nationality or pay in the prompt", leaks, []);
}

{
  const prompt = matchPrompt(job, [matchLine(1, person)]);
  eq("asks for number|score|reason, nothing more", [prompt.includes("number|score|reason"), prompt.includes("0 to 100")], [true, true]);
}

console.log("\nwhich answers count");
const stream = (answer: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: typeof answer === "string" ? answer : JSON.stringify(answer), ...extra });
{
  const r = readMatch(stream([
    "1|82|Six years of IFRS reporting in manufacturing; no team lead role yet",
    "1|90|Said twice",
    "3|70|Nobody asked about three",
    "2|64|   ",
    "2|140|Score out of range",
    "x|60|Not a number",
    "2|64|Payroll and SAP, but only three years",
  ].join("\n")), 2);
  eq("one per person asked about, with its score", [...r.results.entries()], [
    [1, { score: 82, reason: "Six years of IFRS reporting in manufacturing; no team lead role yet" }],
    [2, { score: 64, reason: "Payroll and SAP, but only three years" }],
  ]);
  eq("the rest counted as dropped", r.rejected, 4);
}
eq("a reason with a | in it is kept whole", readMatch(stream("1|75|SAP | Oracle both"), 1).results.get(1)?.reason, "SAP | Oracle both");
eq("a missing score: dropped", readMatch(stream("1||Fits."), 1).results.size, 0);
eq("a code fence around the answer is read", readMatch(stream("```\n1|70|Fits.\n```"), 1).results.get(1), { score: 70, reason: "Fits." });
eq("words instead of lines: nothing", readMatch(stream("I could not judge these people."), 1).results.size, 0);
eq("a failed run: an error, nothing kept", readMatch(stream("usage limit", { subtype: "error_during_execution", is_error: true }), 1).error?.startsWith("claude_failed"), true);
eq("no result at all: an error", readMatch("", 1).error, "claude_no_answer");
{
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  eq("a reason that runs long is cut", readMatch(stream(`1|70|${long}`), 1).results.get(1)?.reason.endsWith("…"), true);
}

console.log("\nDeepSeek's plain-text answer, when Claude had none");
eq("lines read the same way", [...readMatchText("Sure:\n2|71|Payroll and SAP.\n9|80|x", 2).results], [[2, { score: 71, reason: "Payroll and SAP." }]]);
eq("JSON is read too", [...readMatchText('[{"n":2,"score":71,"why":"Payroll and SAP."}]', 2).results], [[2, { score: 71, reason: "Payroll and SAP." }]]);

console.log("\nwho goes on the list, by the model's score");
{
  const pool = ["a", "b", "c", "d", "e"].map((id) => ({ candidate: { id } }));
  const verdicts = new Map([
    ["a", { score: 62, reason: "" }], ["b", { score: 91, reason: "" }], ["c", { score: 40, reason: "" }], ["d", { score: 77, reason: "" }],
  ]);
  const r = pickByScore(pool, verdicts, 2, 60);
  eq("best first, as many as there is room for", r.chosen.map((p) => p.candidate.id), ["b", "d"]);
  eq("under the bar counted", r.under, 1);
  eq("not answered for counted", r.unscored, 1);
  eq("room enough: everyone over the bar", pickByScore(pool, verdicts, 10, 60).chosen.map((p) => p.candidate.id), ["b", "d", "a"]);
}

console.log("\noutput saved against the old JSON answer");
{
  const reasons = Array.from({ length: 30 }, (_, i) => `${4 + (i % 5)} yrs IFRS reporting in manufacturing; no team-lead role yet`);
  const lines = reasons.map((why, i) => `${i + 1}|${60 + (i % 35)}|${why}`).join("\n");
  const json = JSON.stringify(reasons.map((why, i) => ({ n: i + 1, score: 60 + (i % 35), why })));
  const saved = Math.round((1 - lines.length / json.length) * 100);
  console.log(`  (30 people: ${lines.length} chars as lines, ${json.length} as JSON — ${saved}% less)`);
  eq("lines are shorter than JSON", lines.length < json.length, true);
}

console.log("\nthe switch");
const set = (v: Record<string, string | undefined>) => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.C141_CLAUDE_MATCH;
  Object.assign(process.env, v);
};
set({});
eq("nothing set: off", claudeMatchOn(), false);
set({ C141_CLAUDE_MATCH: "on" });
eq("on but no token: off", claudeMatchOn(), false);
set({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
eq("token but not on: off", claudeMatchOn(), false);
set({ CLAUDE_CODE_OAUTH_TOKEN: "t", C141_CLAUDE_MATCH: "on" });
eq("both: on", claudeMatchOn(), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
