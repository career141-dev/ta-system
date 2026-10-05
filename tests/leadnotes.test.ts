/**
 * Notes a lead leaves for the TA on an Excel Tables row (25 Sep): how they are
 * stored, who they read as coming from, and which rows a TA is shown. Run
 * against a disposable copy of the seed — never the platform's own data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-leadnotes-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { scopeLinks } = await import("@/lib/visibility");
const { noteByline, newestFirst } = await import("@/lib/leadNotes");
import type { LinkVaultEntry, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

repo.reset();
const lead = repo.users().find((u) => u.role === "ta_lead")!;
const director = repo.users().find((u) => u.role === "director")!;
const row = repo.openings().flatMap((o) => repo.linkVault(o.id))[0];
const rowNow = () => repo.linkVault(row.openingId).find((l) => l.id === row.id)!;
const before = { outcome: row.outcome, log: row.conversationLog.length };

console.log("\nstoring a note");
const first = repo.addLeadNote(row.id, lead.id, lead.role, "Call before Friday — they are interviewing elsewhere.");
eq("returns the note's id", typeof first === "string" && first.startsWith("ln_"), true);
eq("saved with its author and their role", rowNow().leadNotes?.map((n) => [n.by, n.byRole, n.note]), [
  [lead.id, "ta_lead", "Call before Friday — they are interviewing elsewhere."],
]);
eq("is not an approach: the outcome stays", rowNow().outcome, before.outcome);
eq("and the approach log is untouched", rowNow().conversationLog.length, before.log);

const second = repo.addLeadNote(row.id, director.id, director.role, "Strong fit.");
eq("a second note adds to the first", rowNow().leadNotes?.length, 2);
eq("a missing row is refused", repo.addLeadNote("lv_missing", lead.id, lead.role, "x"), null);

console.log("\nremoving a note");
repo.removeLeadNote(row.id, first!);
eq("only that note goes", rowNow().leadNotes?.map((n) => n.id), [second]);

console.log("\nwho a note reads as coming from");
const names = { [lead.id]: lead.name, [director.id]: director.name };
const noteBy = (by: User, at = 0) => ({ id: "n", at, note: "", by: by.id, byRole: by.role });
eq("a lead's note", noteByline(noteBy(lead), names), { role: "TA Lead", name: lead.name });
eq("a director's note", noteByline(noteBy(director), names), { role: "Director", name: "Director" });
eq("the role saved with it, not today's", noteByline({ ...noteBy(lead), byRole: "admin" }, names).role, "Admin");
eq("newest first", newestFirst([noteBy(lead, 1), noteBy(director, 2)]).map((n) => n.at), [2, 1]);
eq("no notes is an empty list", newestFirst(undefined), []);

console.log("\nwhich rows a TA sees");
const mk = (id: string, addedBy: string, outcome: LinkVaultEntry["outcome"]): LinkVaultEntry =>
  ({ ...row, id, addedBy, outcome, leadNotes: undefined });
const ta = { id: "u_me", role: "ta", isActive: true } as User;
const deskWide = (id: string) => id === "u_lead";
const seen = (rows: LinkVaultEntry[], u: User = ta) =>
  scopeLinks(rows, u, deskWide).map((s) => [s.row.id, s.takenBy]);
eq("a row a lead added is theirs to work, not taken", seen([mk("a", "u_lead", "shortlisted")]), [["a", null]]);
eq("even before it is shortlisted", seen([mk("b", "u_lead", "no_contact")]), [["b", null]]);
eq("another TA's unshortlisted row stays hidden", seen([mk("c", "u_other", "contacted")]), []);
// 1 Oct: every row arrives Shortlisted, so "shortlisted" put all of another
// TA's saved links in your table. Only a person they really took on shows.
eq("another TA's saved link (Shortlisted by default) stays hidden", seen([mk("d", "u_other", "shortlisted")]), []);
// 5 Oct: not even a person they have taken on — the other TA's work is theirs.
eq("another TA's row whose person is on the pipeline stays hidden", seen([mk("d2", "u_other", "shortlisted")]), []);
eq("another TA's row with a CV received stays hidden", seen([mk("d3", "u_other", "cv_received")]), []);
eq("their own row, as before", seen([mk("e", "u_me", "contacted")]), [["e", null]]);
eq(
  "a lead sees every row",
  seen([mk("c", "u_other", "contacted")], { id: "u_lead", role: "ta_lead", isActive: true } as User),
  [["c", null]],
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
