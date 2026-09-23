/**
 * Stage names across the Follow-up split (convex/ta/stages.ts, 22 September).
 */
import { toBackendStage, toTaStage } from "../convex/ta/stages";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe two Follow-ups");
eq("the AI's shortlist is AI Follow-up", toTaStage("ta_shortlist"), "ai_follow_up");
eq("a TA's shortlist is TA Follow-up", toTaStage("follow_up"), "ta_follow_up");
eq("TA Follow-up is stored as follow_up", toBackendStage("ta_follow_up"), "follow_up");
eq("AI Follow-up is stored as ta_shortlist", toBackendStage("ai_follow_up"), "ta_shortlist");
eq("the old name, from a page left open, still means TA Follow-up", toBackendStage("follow_up"), "follow_up");
let threw = false;
try {
  toBackendStage("nonsense");
} catch {
  threw = true;
}
eq("an unknown name is still refused", threw, true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
