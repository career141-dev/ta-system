/**
 * Notes on a person in Director review (29 Sep): anyone on the opening may add
 * one, clients may not, and only the writer removes their own. Run against a
 * disposable copy of the seed — never the platform's own data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-reviewnotes-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { can } = await import("@/lib/auth");
import type { User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

repo.reset();
const u = (role: User["role"]): User => ({ id: `u_${role}`, role, isActive: true } as User);
const assigned = { openingId: "o", assignment: { role: "primary_recruiter" } as never };

console.log("\nwho may add a note");
for (const role of ["ta_lead", "director", "admin", "ops"] as const) {
  eq(`${role}, desk-wide`, can(u(role), "review.note", { openingId: "o" }).ok, true);
}
eq("a TA on the opening", can(u("ta"), "review.note", assigned).ok, true);
eq("a TA not on it", can(u("ta"), "review.note", { openingId: "o" }).ok, false);
eq("a client", can(u("client"), "review.note", assigned).ok, false);
eq("a viewer", can(u("viewer"), "review.note", { openingId: "o" }).ok, false);

console.log("\nstoring and removing");
const app = repo.applications(repo.openings()[0].id)[0];
const now = () => repo.application(app.id)!.reviewNotes;
const a = repo.addReviewNote(app.id, "u_ta", "ta", "Sent with the CV.");
const b = repo.addReviewNote(app.id, "u_director", "director", "Strong fit.");
eq("both notes kept, with author and role", now()?.map((n) => [n.by, n.byRole]), [["u_ta", "ta"], ["u_director", "director"]]);
eq("a missing application is refused", repo.addReviewNote("missing", "u_ta", "ta", "x"), null);
repo.removeReviewNote(app.id, a!);
eq("only that note goes", now()?.map((n) => n.id), [b]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
