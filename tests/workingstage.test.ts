/**
 * Tests for the TA Working Stage feature:
 * - Independent stage per TA per Opening
 * - Defaults to "100%"
 * - Reflects in EOD effortRow
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-stage-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { effortRow } = await import("@/lib/eod");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const fresh = () => repo.reset();

console.log("\nworkingStage: defaults to 100% and can be updated per TA");
fresh();
// Two TAs on the same opening: a working stage belongs to an assignment.
const opening = repo.openings().find((o) => o.assignedTaIds.filter((t) => repo.assignmentFor(o.id, t)).length >= 2) ?? repo.openings()[0];
const onIt = opening.assignedTaIds.filter((t) => repo.assignmentFor(opening.id, t));
const ta1 = repo.user(onIt[0])!;
const ta2 = repo.user(onIt[1] ?? onIt[0])!;

eq("TA 1 default stage is 100%", repo.workingStage(opening.id, ta1.id), "100%");
eq("TA 2 default stage is 100%", repo.workingStage(opening.id, ta2.id), "100%");

const eod1 = effortRow(opening.id, ta1);
eq("TA 1 effort row starts with 100%", eod1.hundredOrFollowUp, "100%");

const teamBefore = repo.assignments(opening.id).map((a) => a.userId).sort();
repo.setWorkingStage(opening.id, ta1.id, "Follow-up");
eq("TA 1 stage is now Follow-up", repo.workingStage(opening.id, ta1.id), "Follow-up");
eq("TA 2 stage remains 100%", repo.workingStage(opening.id, ta2.id), "100%");

const eodFollowUp = effortRow(opening.id, ta1);
eq("TA 1 effort row now has Follow-up", eodFollowUp.hundredOrFollowUp, "Follow-up");

repo.setWorkingStage(opening.id, ta1.id, "Add-on");
eq("TA 1 stage is now Add-on", repo.workingStage(opening.id, ta1.id), "Add-on");
const eodAddOn = effortRow(opening.id, ta1);
eq("TA 1 effort row now has Add-on", eodAddOn.hundredOrFollowUp, "Add-on");

eq("the rest of the team is still on the opening", repo.assignments(opening.id).map((a) => a.userId).sort(), teamBefore);

console.log("\nsomeone not on the opening is not put on it");
const outsider = repo.users().find((u) => u.role === "ta_lead" && !repo.assignmentFor(opening.id, u.id));
if (outsider) {
  repo.setWorkingStage(opening.id, outsider.id, "Follow-up");
  eq("no assignment is created for them", !!repo.assignmentFor(opening.id, outsider.id), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
