/**
 * "Not disclosed" is an answer (owner, 28 Sep): a candidate who will not say
 * their salary or notice can still go to Director Review once the TA has
 * written that down — in the backend's gate and in the app's own check.
 */
import { directorReviewBlockers as backendBlockers } from "../convex/ta/stages";
import { directorReviewBlockers as appBlockers } from "@/lib/pipeline";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nbackend gate (convex/ta/stages.ts)");
const app = { cvFileId: "cv1" };
eq("nothing on file: both asked for", backendBlockers(app, {}), ["expected salary", "notice period"]);
eq("words count", backendBlockers(app, { taExpectedSalaryText: "Not disclosed", noticePeriod: "Not disclosed" }), []);
eq("the candidate's own words count", backendBlockers(app, { expectedSalaryNote: "Negotiable", noticePeriodDays: 30 }), []);
eq("a number still counts", backendBlockers(app, { expectedSalary: 300000, noticePeriodDays: 0 }), []);
eq("blank words do not", backendBlockers(app, { taExpectedSalaryText: "  ", noticePeriod: "" }), ["expected salary", "notice period"]);
eq("current salary is never asked for", backendBlockers(app, { expectedSalary: 1, noticePeriodDays: 1 }).includes("current salary"), false);

console.log("\napp check (src/lib/pipeline.ts)");
const c = (over: Record<string, unknown>) =>
  ({ cvFileName: "cv.pdf", currentSalary: null, expectedSalary: null, noticePeriodDays: null, noticePeriod: null, ...over }) as never;
eq("Not disclosed for both", appBlockers(c({ expectedSalary: "Not disclosed", noticePeriod: "Not disclosed" })), []);
eq("still asks when empty", appBlockers(c({})), ["expected salary", "notice period"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
