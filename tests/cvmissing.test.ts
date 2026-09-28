/**
 * CVs lost in the Convex Cloud move (28 Sep): who is kept out of search and
 * matching, and that getting any other CV lets them back in. Run against a
 * disposable copy of the seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-cvmissing-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { cvFileMissing } = await import("@/lib/cvMissing");
const { mapCandidate } = await import("@/lib/live/mapLive");
const { failsHardRules } = await import("@/lib/dbMatch");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe mark");
eq("marked while the lost upload is still their CV", cvFileMissing({ cvMissingUploadId: "u1", cvUploadId: "u1" }), true);
eq("lifts once any other CV is linked", cvFileMissing({ cvMissingUploadId: "u1", cvUploadId: "u2" }), false);
eq("nobody else is marked", cvFileMissing({ cvUploadId: "u1" }), false);

console.log("\nit reaches the app");
eq("the list row carries it", mapCandidate({ _id: "c1", fullName: "A", cvFileMissing: true }, null).cvFileMissing, true);
eq("an ordinary row has no such field", "cvFileMissing" in mapCandidate({ _id: "c1", fullName: "A" }, null), false);

console.log("\nautomatic database matches leave them out");
{
  const opening = repo.openings()[0];
  const someone = repo.candidates()[0];
  const o = { id: opening.id, clientId: opening.clientId, locations: [], targetNationalities: [] };
  eq("an ordinary person passes", failsHardRules(someone, o, null), null);
  eq("someone whose CV was lost does not", failsHardRules({ ...someone, cvFileMissing: true }, o, null), "cv_missing");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
