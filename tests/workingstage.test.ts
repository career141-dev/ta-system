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
const opening = repo.openings()[0];
const tas = repo.users().filter((u) => u.role === "ta");
const ta1 = tas[0];
const ta2 = tas[1];

eq("TA 1 default stage is 100%", repo.workingStage(opening.id, ta1.id), "100%");
eq("TA 2 default stage is 100%", repo.workingStage(opening.id, ta2.id), "100%");

const eod1 = effortRow(opening.id, ta1);
eq("TA 1 effort row starts with 100%", eod1.hundredOrFollowUp, "100%");

repo.setWorkingStage(opening.id, ta1.id, "Follow-up");
eq("TA 1 stage is now Follow-up", repo.workingStage(opening.id, ta1.id), "Follow-up");
eq("TA 2 stage remains 100%", repo.workingStage(opening.id, ta2.id), "100%");

const eodFollowUp = effortRow(opening.id, ta1);
eq("TA 1 effort row now has Follow-up", eodFollowUp.hundredOrFollowUp, "Follow-up");

repo.setWorkingStage(opening.id, ta1.id, "Add-on");
eq("TA 1 stage is now Add-on", repo.workingStage(opening.id, ta1.id), "Add-on");
const eodAddOn = effortRow(opening.id, ta1);
eq("TA 1 effort row now has Add-on", eodAddOn.hundredOrFollowUp, "Add-on");

if (fail > 0) process.exit(1);
