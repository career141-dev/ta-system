/**
 * Which tasks may go to the owner's Claude subscription (src/lib/claudeSub).
 * The point of the gate: a candidate's CV or messages never reach a personal
 * account, whatever C141_CLAUDE_SUB_TASKS says. And what keeps the desk
 * moving when the subscription cannot answer: a rest after a usage limit, a
 * cap on CLI runs at once, and OpenRouter behind it all.
 */
import { pauseReason, pauseSubscription, resetSubscriptionState, takeTurn, viaSubscription } from "@/lib/claudeSub";
import { write } from "@/lib/ai";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const set = (v: Record<string, string | undefined>) => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.C141_CLAUDE_SUB_TASKS;
  Object.assign(process.env, v);
};

console.log("\nwho may use the Claude subscription");
set({ C141_CLAUDE_SUB_TASKS: "plan" });
eq("no token: nothing goes to it", viaSubscription("plan"), false);
set({ CLAUDE_CODE_OAUTH_TOKEN: "t", C141_CLAUDE_SUB_TASKS: "plan, research" });
eq("research and suggestions do, once named", [viaSubscription("plan"), viaSubscription("research")], [true, true]);
eq("a task not named does not", viaSubscription("jd"), false);
set({ CLAUDE_CODE_OAUTH_TOKEN: "t", C141_CLAUDE_SUB_TASKS: "rank,parse,extract,assist" });
eq("CV and message tasks are refused even when named", ["rank", "parse", "extract", "assist"].map((t) => viaSubscription(t as never)), [false, false, false, false]);
set({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
eq("nothing named: off", viaSubscription("plan"), false);

console.log("\nwhat rests the subscription");
eq("a usage limit", pauseReason("Claude AI usage limit reached|1758700000"), "usage limit");
eq("the plan's limit, newer wording", pauseReason("You've hit your limit · resets 3pm"), "usage limit");
eq("a lapsed token", pauseReason("OAuth token has expired. Please run /login"), "login");
eq("anything else is not a reason to rest", pauseReason("Error: socket hang up"), null);
set({ CLAUDE_CODE_OAUTH_TOKEN: "t", C141_CLAUDE_SUB_TASKS: "plan" });
const t0 = 1_000_000;
pauseSubscription("usage limit", t0);
eq("while resting, calls skip it", viaSubscription("plan", t0 + 60_000), false);
eq("after 15 minutes it is used again", viaSubscription("plan", t0 + 15 * 60_000), true);
resetSubscriptionState();

// OpenRouter answers everything in this file; nothing leaves the machine.
const hosts: string[] = [];
globalThis.fetch = (async (url: string) => {
  hosts.push(new URL(String(url)).hostname);
  return Response.json({ choices: [{ message: { content: "from openrouter" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
}) as typeof fetch;

async function main() {
  console.log("\nhow many run at once");
  process.env.C141_CLAUDE_SUB_CONCURRENCY = "2";
  const a = await takeTurn(50);
  const b = await takeTurn(50);
  eq("two get a turn straight away", [Boolean(a), Boolean(b)], [true, true]);
  eq("a third waits, and gives up when none comes", await takeTurn(50), null);
  const third = takeTurn(1000);
  a!();
  a!(); // released twice: counted once
  eq("it gets the turn a finished one gives back", Boolean(await third), true);
  eq("and the one after still waits", await takeTurn(50), null);
  resetSubscriptionState();
  delete process.env.C141_CLAUDE_SUB_CONCURRENCY;

  console.log("\nthe CLI missing: Research still gets an answer");
  set({ CLAUDE_CODE_OAUTH_TOKEN: "t", C141_CLAUDE_SUB_TASKS: "plan" });
  process.env.OPENROUTER_API_KEY = "o";
  process.env.C141_CLAUDE_BIN = "c141-no-such-claude";
  const r = await write("sys", "prompt", 600, "plan");
  eq("from OpenRouter", [r.ok && r.text, hosts], ["from openrouter", ["openrouter.ai"]]);
  eq("and the subscription is not rested for it", viaSubscription("plan"), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
