/**
 * TA Support (9 Oct): a TA's access in every respect, except that on a job's
 * Excel Tables they read every TA's rows, not only their own. Reading only —
 * another TA's row is still theirs to work.
 */
const { scopeLinks } = await import("@/lib/visibility");
const { can, isTa, isDeskWide, seesEveryTaRow } = await import("@/lib/auth");
const { mapUser } = await import("@/data/convex/map");
const { needsResearchLink } = await import("@/lib/eod-format");
const { assignableTas } = await import("@/lib/assignable");
import type { Assignment, LinkVaultEntry, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const ta = { id: "u_ta", role: "ta", isActive: true } as User;
const other = { id: "u_other", role: "ta", isActive: true } as User;
const support = { id: "u_support", role: "ta_support", isActive: true } as User;
const mk = (id: string, addedBy: string) => ({ id, addedBy } as LinkVaultEntry);
const deskWide = (id: string) => id === "u_lead";
const seen = (u: User) =>
  scopeLinks([mk("a", "u_ta"), mk("b", "u_other"), mk("c", "u_lead"), mk("d", "u_support")], u, deskWide).map((s) => s.row.id);

console.log("\nExcel Tables: whose rows");
eq("a TA sees their own rows and a lead's", seen(ta), ["a", "c"]);
eq("TA Support sees both TAs' rows on the job, and their own", seen(support), ["a", "b", "c", "d"]);
eq("a TA does not see TA Support's rows", seen(other), ["b", "c"]);

console.log("\nthe same access as a TA otherwise");
const onJob = { role: "supporting_recruiter" } as Assignment;
eq("counts as a TA", isTa(support), true);
eq("is not desk-wide", isDeskWide(support), false);
eq("only TA Support reads every TA's rows", [ta, support].map(seesEveryTaRow), [false, true]);
eq("works sourcing on a job they are on", can(support, "opening.sourcing", { assignment: onJob }).ok, true);
eq("cannot work another TA's row", can(support, "opening.sourcing", { assignment: onJob, ownerTaId: "u_ta" }).ok, false);
eq("cannot act on another TA's claimed candidate", can(support, "opening.act", { assignment: onJob, ownerTaId: "u_ta" }).ok, false);
eq("is a stranger to a job they are not on", can(support, "opening.read").ok, false);
eq("cannot leave lead notes", can(support, "link.note").ok, false);
eq("works strategies given to them", can(support, "strategy.work", { assignment: onJob }).ok, true);
eq("no voice practice line, as for a TA", can(support, "voice.practice").ok, false);
eq("attaches the research link on the director EOD", needsResearchLink("ta_support", "director"), true);
eq("can be put on an opening", assignableTas([support, { ...ta, role: "ta_lead" } as User]).map((u) => u.id), ["u_support"]);

console.log("\nthe backend role reads back");
eq(
  "taRole ta_support maps to TA Support, not viewer",
  mapUser({ _id: "x", email: "s@x.com", fullName: "S", role: "recruiter", taRole: "ta_support", isActive: true }).role,
  "ta_support",
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
