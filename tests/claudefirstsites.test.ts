/**
 * The three backend matching calls, Claude first (5 Oct): role level
 * (classifyCurrentRolesBatch), CV against a job (scoreWithLLM) and AI search
 * ranking (scoreBatchWithLLM). The network is faked, both the app's Claude
 * route and DeepSeek's: nothing leaves the machine.
 *
 * Under test: Claude's answer is used when it reads; when Claude says no, or
 * answers with something unreadable, DeepSeek is asked exactly as before; and
 * no candidate's name is in what Claude is sent.
 */
import { scoreWithLLM, scoreBatchWithLLM } from "../convex/cvs/cvScoring";
import { classifyCurrentRolesBatch } from "../convex/lib/currentRoleClassifier";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

process.env.C141_APP_INTERNAL_URL = "http://app:3000";
process.env.C141_CLAUDE_BRIDGE_SECRET = "a-long-enough-test-secret";
process.env.OPENROUTER_API_KEY = "sk-or-test-not-a-real-key";
process.env.NVIDIA_API_KEY = "nv-test-not-a-real-key";

// What the fake network answers, set per case.
let claudeAnswer: { status: number; text?: string } = { status: 503 };
let deepseekAnswer = "{}";
const seen = { claudePrompts: [] as string[], deepseekCalls: 0 };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/internal/claude")) {
    seen.claudePrompts.push(JSON.parse(String(init?.body)).prompt);
    return new Response(JSON.stringify(claudeAnswer.status === 200 ? { ok: true, text: claudeAnswer.text } : { ok: false, reason: "busy" }), { status: claudeAnswer.status });
  }
  seen.deepseekCalls++;
  return new Response(JSON.stringify({
    id: "x", object: "chat.completion", created: 0, model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: deepseekAnswer } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const reset = (claude: typeof claudeAnswer, deepseek: string) => {
  claudeAnswer = claude;
  deepseekAnswer = deepseek;
  seen.claudePrompts = [];
  seen.deepseekCalls = 0;
};

const cv = {
  fullName: "Nimali Perera", currentTitle: "Senior Accountant", currentEmployer: "Hayleys", totalExperienceYears: 6,
  skills: ["IFRS", "SAP"], jobHistory: [{ title: "Accountant", company: "John Keells", startDate: "2018", endDate: "2021" }],
};
const req = { title: "Finance Manager", requiredSkills: ["IFRS"], preferredSkills: [], minYearsExperience: 5, seniority: "manager", industry: "FMCG", summary: "Own month-end close." };

console.log("\nCV against a job");
reset({ status: 200, text: '```json\n{"score": 82, "reason": "Six years of IFRS work."}\n```' }, "{}");
{
  const r = await scoreWithLLM(cv, req as never);
  eq("Claude's score is used", [r.result.score, r.result.reason, r.usage.model], [82, "Six years of IFRS work.", "claude-subscription"]);
  eq("DeepSeek not asked", seen.deepseekCalls, 0);
  eq("no name in what Claude was sent", seen.claudePrompts[0].includes("Nimali") || seen.claudePrompts[0].includes("Perera"), false);
  eq("the work is", seen.claudePrompts[0].includes("Senior Accountant"), true);
}
reset({ status: 503 }, '{"score": 64, "reason": "From DeepSeek."}');
{
  const r = await scoreWithLLM(cv, req as never);
  eq("Claude busy: DeepSeek's score", [r.result.score, r.result.reason], [64, "From DeepSeek."]);
}
reset({ status: 200, text: "I would rather not score this." }, '{"score": 51, "reason": "From DeepSeek."}');
eq("Claude unreadable: DeepSeek's score", (await scoreWithLLM(cv, req as never)).result.score, 51);

console.log("\nAI search ranking");
const pool = [
  { index: 1, overallScore: 70, cv: { ...cv } },
  { index: 2, overallScore: 60, cv: { ...cv, fullName: "Kasun Silva", currentTitle: "Finance Executive" } },
];
reset({ status: 200, text: '{"evaluations":[{"id":1,"score":88,"reason":"Strong IFRS."},{"id":2,"score":61,"reason":"Junior."}]}' }, "{}");
{
  const r = await scoreBatchWithLLM(pool as never, req as never);
  eq("Claude's ranking is used", [[...r.evaluations.entries()], r.usage.model], [[[1, { score: 88, reason: "Strong IFRS." }], [2, { score: 61, reason: "Junior." }]], "claude-subscription"]);
  eq("DeepSeek not asked", seen.deepseekCalls, 0);
  eq("names replaced by numbers", ["Nimali", "Kasun"].some((n) => seen.claudePrompts[0].includes(n)) || !seen.claudePrompts[0].includes("Candidate #2"), false);
}
reset({ status: 503 }, '{"evaluations":[{"id":1,"score":70,"reason":"From DeepSeek."}]}');
{
  const r = await scoreBatchWithLLM(pool as never, req as never);
  eq("Claude busy: DeepSeek's ranking", [[...r.evaluations.entries()], seen.deepseekCalls], [[[1, { score: 70, reason: "From DeepSeek." }]], 1]);
}

console.log("\nrole level");
const people = [{ _id: "c1", currentJobTitle: "Finance Manager", currentEmployer: "Hayleys", sector: "FMCG", totalExperienceYears: 9 }];
const roleAnswer = (rank: number) => JSON.stringify({ c1: { rank, rankLabel: "Manager", confidence: "high", reasoning: "r", roleFamily: "finance_accounting", roleFamilyMatch: "exact", exclusionReason: null } });
reset({ status: 200, text: roleAnswer(5) }, roleAnswer(2));
{
  const r = await classifyCurrentRolesBatch({}, people, "Finance Manager", "finance_accounting");
  eq("Claude's level is used", [r.get("c1")?.rank, seen.deepseekCalls], [5, 0]);
}
reset({ status: 503 }, roleAnswer(2));
{
  const r = await classifyCurrentRolesBatch({}, people, "Finance Manager", "finance_accounting");
  eq("Claude busy: DeepSeek's level", [r.get("c1")?.rank, seen.deepseekCalls], [2, 1]);
}
reset({ status: 200, text: '{"somebody_else": {"rank": 9}}' }, roleAnswer(3));
eq("Claude answered about someone not asked: DeepSeek", (await classifyCurrentRolesBatch({}, people, "Finance Manager", "finance_accounting")).get("c1")?.rank, 3);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
