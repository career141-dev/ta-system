/**
 * Which tasks may go to the owner's Claude subscription (src/lib/claudeSub).
 * The point of the gate: a candidate's CV or messages never reach a personal
 * account, whatever C141_CLAUDE_SUB_TASKS says.
 */
import { viaSubscription } from "@/lib/claudeSub";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
