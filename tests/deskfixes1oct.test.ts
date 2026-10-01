/**
 * The desk's 1 October report: the end-of-day SETS cell doubling its CV count,
 * the app's own "Headhunted —" note showing as a TA's note, and a headhunted
 * CV's claim being invisible to the other TAs on the opening.
 */
import { setsCell } from "@/lib/eod-format";
import { isSystemNote } from "@/lib/pdf";
import { scopeLinks } from "@/lib/visibility";
import type { LinkVaultEntry, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nSETS: the CV count once");
eq("typed as the email shows it", setsCell("2 · 14 CVs", 14), "2 · 14 CVs");
eq("typed with an old count", setsCell("2 · 9 CVs", 14), "2 · 14 CVs");
eq("just the sets", setsCell("2", 14), "2 · 14 CVs");
eq("nothing typed", setsCell("", 1), "1 CV");

console.log("\nthe app's own notes are not the TA's");
eq("Headhunted — shortlisted …", isSystemNote("Headhunted — shortlisted in Excel Tables by Sanduni"), true);
eq("…with the email's >", isSystemNote(">Headhunted — not interested, in Excel Tables by Hifa"), true);
eq("a TA's note about headhunting stays", isSystemNote("Headhunted from Dialog, keen to move"), false);

console.log("\na headhunted CV is a claim the others see");
const ta = { id: "u_hifa", role: "ta", isActive: true } as User;
const row = (outcome: LinkVaultEntry["outcome"]) => ({ id: `r_${outcome}`, addedBy: "u_sanduni", outcome }) as LinkVaultEntry;
const seen = scopeLinks([row("shortlisted"), row("cv_received"), row("contacted")], ta, () => false).map((s) => [s.row.id, s.takenBy]);
eq("a CV received shows as Sanduni's; a saved link or a contact stays hers alone", seen, [["r_cv_received", "u_sanduni"]]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
