/**
 * Database-match reasons by Claude (src/lib/claudeMatch). The rules under
 * test: nothing that names or reaches a candidate goes into the prompt; an
 * answer counts only for a person who was asked about; and the switch is off
 * unless both the setting and the subscription token are there.
 */
import { claudeMatchOn, matchLine, matchPrompt, readMatch, type MatchJob } from "@/lib/claudeMatch";
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

console.log("\nwhich answers count");
const stream = (answer: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: typeof answer === "string" ? answer : JSON.stringify(answer), ...extra });
{
  const r = readMatch(stream([
    { n: 1, why: "Six years of IFRS reporting in manufacturing; no team lead role yet." },
    { n: 1, why: "Said twice." },
    { n: 3, why: "Nobody asked about three." },
    { n: 2, why: "   " },
    { n: "2", why: "Payroll and SAP, but only three years." },
  ]), 2);
  eq("one per person asked about", [...r.reasons.entries()], [[1, "Six years of IFRS reporting in manufacturing; no team lead role yet."], [2, "Payroll and SAP, but only three years."]]);
  eq("the rest counted as dropped", r.rejected, 3);
}
eq("a code fence around the answer is read", readMatch(stream('```json\n[{"n":1,"why":"Fits."}]\n```'), 1).reasons.get(1), "Fits.");
eq("words instead of JSON: nothing", readMatch(stream("I could not judge these people."), 1).reasons.size, 0);
eq("a failed run: an error, nothing kept", readMatch(stream("usage limit", { subtype: "error_during_execution", is_error: true }), 1).error?.startsWith("claude_failed"), true);
eq("no result at all: an error", readMatch("", 1).error, "claude_no_answer");
{
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  eq("a reason that runs long is cut", readMatch(stream([{ n: 1, why: long }]), 1).reasons.get(1)?.endsWith("…"), true);
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
