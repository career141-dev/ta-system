/**
 * Back to Excel Tables (29 Sep): someone put on the pipeline from an Excel
 * Tables row can be sent back to it, and "Add to pipeline" brings the same
 * application back. Run against a disposable copy of the seed — never the
 * platform's own data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-backtotables-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { BACK_TO_TABLES_REASON, cameFromTables, movedBackToTables } = await import("@/lib/pipeline");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

repo.reset();
const ta = repo.users().find((u) => u.role === "ta")!;
const row = repo.openings().flatMap((o) => repo.linkVault(o.id)).find((l) => !l.candidateId)!;
repo.updateLink(row.id, { outcome: "shortlisted", name: "Nimal Perera" });

console.log("\nadded from Excel Tables");
const made = repo.linkToApplication(row.id, ta.id);
if (!made.ok) throw new Error(made.message);
const app = () => repo.application(made.applicationId)!;
const rows = () => repo.linkVault(row.openingId);
eq("is on the pipeline in Follow-up", app().stage, "ta_follow_up");
eq("the menu offers Back to Excel Tables", cameFromTables(app(), rows()), true);
const other = repo.applications(row.openingId).find((a) => a.id !== made.applicationId && a.stage !== "dropped_out" && a.stage !== "rejected")!;
eq("but not for someone who came another way", cameFromTables(other, rows()), false);

console.log("\nmoved back");
const back = repo.moveStage(made.applicationId, "dropped_out", ta.id, BACK_TO_TABLES_REASON);
eq("the move is allowed", back.ok, true);
eq("kept, under Dropped out, with the reason", [app().stage, app().droppedOutReason], ["dropped_out", BACK_TO_TABLES_REASON]);
eq("Excel Tables reads them as off the pipeline", movedBackToTables(app()), true);
eq("and the menu no longer offers it", cameFromTables(app(), rows()), false);
eq("an ordinary drop-out still reads as on the pipeline", movedBackToTables({ stage: "dropped_out", droppedOutReason: "Accepted another offer" }), false);

console.log("\nadded again");
const again = repo.linkToApplication(row.id, ta.id);
eq("the same application, not a second one", again.ok && again.applicationId, made.applicationId);
eq("with no second candidate on the opening", repo.applications(row.openingId).filter((a) => a.candidateId === app().candidateId).length, 1);
repo.moveStage(made.applicationId, "ta_follow_up", ta.id, "Brought back");
eq("brought back clears the reason", [app().stage, app().droppedOutReason, movedBackToTables(app())], ["ta_follow_up", null, false]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
