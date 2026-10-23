import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "c141-ta-report-")));
const { repo } = await import("@/data/store");
const { PRESETS } = await import("@/lib/reportSpec");
const { runReport, reportCsv } = await import("@/lib/reporting");

const [first, second] = repo.users().filter((user) => user.role === "ta");
assert.ok(first && second);
const opening = repo.openings()[0]!;
repo.setAssignments(opening.id, [
  { userId: first.id, role: "primary_recruiter" },
  { userId: second.id, role: "supporting_recruiter" },
], first.id);

const spec = PRESETS.find((preset) => preset.key === "master")!.spec;
const rows = () => runReport(spec).rows.filter((row) => row.id === opening.id);
const before = rows();
const firstBefore = before.find((row) => row.taId === first.id)!;
const secondBefore = before.find((row) => row.taId === second.id)!;
assert.ok(firstBefore && secondBefore, "the shared job has a separate row for each TA");

const firstLink = repo.addLink(opening.id, "https://linkedin.com/in/ta-report-first", first.id, "First Link");
repo.toggleEyeMark(firstLink);
repo.addLink(opening.id, "https://linkedin.com/in/ta-report-first-again", first.id, "Another First Link");
repo.addLink(opening.id, "https://linkedin.com/in/ta-report-second", second.id, "Second Link");
const after = rows();
const firstAfter = after.find((row) => row.taId === first.id)!;
const secondAfter = after.find((row) => row.taId === second.id)!;
assert.equal(Number(firstAfter.hunted), Number(firstBefore.hunted) + 2);
assert.equal(Number(secondAfter.hunted), Number(secondBefore.hunted) + 1);
assert.equal(Number(firstAfter.eyeMarked), Number(firstBefore.eyeMarked) + 1);
assert.equal(Number(secondAfter.eyeMarked), Number(secondBefore.eyeMarked));
assert.equal(firstAfter.positionStatus, secondAfter.positionStatus, "job fields are shared");
assert.notEqual(firstAfter.rowKey, secondAfter.rowKey, "rows and forms have distinct keys");
assert.ok(Number(firstAfter.l1Profiles) >= Number(firstBefore.l1Profiles));
const activeLevel = repo.linkLevels(opening.id, first.id).at(-1);
assert.ok(activeLevel);
const levelsBeforeDeletion = Number(firstAfter.totalLs);
repo.deleteLinkLevel(opening.id, first.id, activeLevel.n);
assert.equal(Number(rows().find((row) => row.taId === first.id)!.totalLs), levelsBeforeDeletion - 1,
  "a deleted L stops counting while its LinkedIn links remain");

const thisMonth = runReport({ ...spec, subjectTaId: first.id, period: "month" }).rows.find((row) => row.id === opening.id)!;
assert.ok(Number(thisMonth.hunted) >= 2, "period activity uses link creation dates");
assert.ok(Number(thisMonth.eyeMarked) >= 1, "new eye marks have their own event date");

const personal = runReport({ ...spec, subjectTaId: first.id }).rows.filter((row) => row.id === opening.id);
assert.deepEqual(personal.map((row) => row.taId), [first.id]);
const csv = reportCsv({ ...spec, subjectTaId: first.id });
assert.ok(csv.includes(first.name));
assert.ok(csv.includes("LinkedIn links"));
assert.ok(!csv.includes(second.name), "the personal export uses the same TA scope");

console.log("TA job report and CSV passed");
