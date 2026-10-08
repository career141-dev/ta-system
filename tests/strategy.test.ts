/**
 * The Strategy Planner (8 Oct): one table per job, a row per strategy. A TA Lead
 * puts TAs on rows, dates them and strikes through the ones that cannot be used;
 * a TA sees their rows and the struck-through ones, fills in what they did with
 * an optional proof, and submits. The rules under test: who may do what, who
 * sees which row, that nothing reaches the lead until the TA submits, that a
 * strategy has one row per job however often it is assigned, and that the new
 * tables are in every list the Convex store needs them in (a missed one fails
 * only in the real backend).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { can } from "@/lib/auth";
import { scopeStrategies } from "@/lib/visibility";
import { colomboDateValue, colomboDayFromValue, colomboDayStart } from "@/lib/calendar";
import { DESK_STRATEGIES, countsOf, plannerByTa, proofsForLead, proofsVisibleTo, strategyTable } from "@/lib/strategyPlanner";
import type { Assignment, StrategyAssignment, User } from "@/data/types";

// The rows are kept in the in-memory JSON store, in a scratch directory.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "c141-strategy-")));
const { repo } = await import("@/data/store");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const user = (role: User["role"], over: Partial<User> = {}): User =>
  ({ id: `u_${role}`, name: role, email: "", phone: null, routingEmail: null, role, initials: "X", isActive: true, ...over });
const on = (role: Assignment["role"], userId = "u_ta"): Assignment =>
  ({ id: "as", openingId: "op", userId, role, assignedAt: 0, assignedBy: null });
const ok = (u: User, cap: Parameters<typeof can>[1], ctx: Parameters<typeof can>[2] = {}) => can(u, cap, ctx).ok;

console.log("\nWho may assign strategies and edit the list");
for (const cap of ["strategy.assign", "strategy.manage"] as const) {
  eq(`${cap}: a TA Lead`, ok(user("ta_lead"), cap), true);
  eq(`${cap}: a director`, ok(user("director"), cap), true);
  eq(`${cap}: an admin`, ok(user("admin"), cap), true);
  eq(`${cap}: a TA is refused`, ok(user("ta"), cap, { assignment: on("primary_recruiter") }), false);
  eq(`${cap}: ops is refused`, ok(user("ops"), cap), false);
  eq(`${cap}: a client is refused`, ok(user("client"), cap), false);
  eq(`${cap}: a viewer is refused`, ok(user("viewer"), cap), false);
  eq(`${cap}: a deactivated lead is refused`, ok(user("ta_lead", { isActive: false }), cap), false);
}

console.log("\nWho may work a strategy they were given");
{
  const ta = user("ta");
  eq("a TA on the job", ok(ta, "strategy.work", { assignment: on("primary_recruiter") }), true);
  eq("a supporting TA on the job", ok(ta, "strategy.work", { assignment: on("supporting_recruiter") }), true);
  eq("a TA not on the job", ok(ta, "strategy.work", {}), false);
  eq("a client contact seat", ok(ta, "strategy.work", { assignment: on("client_contact") }), false);
  eq("a lead does not work strategies as a TA", ok(user("ta_lead"), "strategy.work", { assignment: on("primary_recruiter") }), false);
  eq("a viewer cannot", ok(user("viewer"), "strategy.work", { assignment: on("primary_recruiter") }), false);
}

console.log("\nWho sees which row");
{
  const row = (id: string, doneBy: string[], notApplicable = false): StrategyAssignment => ({
    id, openingId: "op", strategyId: `s_${id}`, strategyName: id.toUpperCase(), doneBy, assignedAt: 1, assignedBy: "u_ta_lead",
    byRole: "ta_lead", notApplicable, doneAt: null, note: null, proofs: [], submittedAt: null, submittedBy: null,
  });
  const rows = [row("a", ["u_ta"]), row("b", ["u_other"]), row("c", ["u_ta", "u_other"]), row("d", [], true), row("e", ["u_other"], true)];
  eq("a TA sees theirs and the struck-through ones", scopeStrategies(rows, user("ta")).map((r) => r.id), ["a", "c", "d", "e"]);
  eq("the other TA sees theirs and the struck-through ones", scopeStrategies(rows, user("ta", { id: "u_other" })).map((r) => r.id), ["b", "c", "d", "e"]);
  eq("a third TA sees only the struck-through ones", scopeStrategies(rows, user("ta", { id: "u_third" })).map((r) => r.id), ["d", "e"]);
  eq("a lead sees all", scopeStrategies(rows, user("ta_lead")).length, 5);
  eq("a director sees all", scopeStrategies(rows, user("director")).length, 5);
  eq("a client sees none, not even the struck-through", scopeStrategies(rows, user("client")).length, 0);
  eq("a viewer sees none", scopeStrategies(rows, user("viewer")).length, 0);
}

console.log("\nThe desk's list");
{
  eq("the 15 strategies, in the owner's order", repo.strategies().map((s) => s.name), DESK_STRATEGIES);
  eq("fifteen", DESK_STRATEGIES.length, 15);
  const id = repo.saveStrategy({ name: "  Build a talent pool  ", description: "Keep warm", group: "Pipeline", byUserId: "u_lead" });
  eq("a strategy is added", !!id && repo.strategy(id!)?.name, "Build a talent pool");
  eq("it joins the end of the list", repo.strategies().at(-1)?.id, id);
  eq("the same name in other capitals is refused", repo.saveStrategy({ name: "build a TALENT pool", description: null, group: null, byUserId: "u_lead" }), null);
  eq("an existing desk name is refused too", repo.saveStrategy({ name: "linkedin search", description: null, group: null, byUserId: "u_lead" }), null);
  eq("an empty name is refused", repo.saveStrategy({ name: "   ", description: null, group: null, byUserId: "u_lead" }), null);
  eq("changing one that is not there is refused", repo.saveStrategy({ id: "st_nope", name: "X", description: null, group: null, byUserId: "u_lead" }), null);
  eq("it can be renamed", repo.saveStrategy({ id: id!, name: "Talent pool", description: null, group: null, byUserId: "u_lead" }), id);
  repo.setStrategyActive(id!, false);
  eq("a retired one leaves the list", repo.strategies().some((s) => s.id === id), false);
  eq("and comes back when asked for", repo.strategies(true).some((s) => s.id === id), true);
}

console.log("\nColombo days in the date columns");
{
  const day = colomboDayStart(Date.UTC(2026, 9, 8, 3, 0)); // 08:30 in Colombo on 8 Oct
  eq("a day reads back as the date typed", colomboDateValue(day), "2026-10-08");
  eq("the early hours of a Colombo day are not yesterday (UTC would say 7 Oct)", colomboDateValue(Date.UTC(2026, 9, 7, 20, 0)), "2026-10-08");
  eq("a typed date is that Colombo day", colomboDayFromValue("2026-10-08"), day);
  eq("an empty value is no date", colomboDayFromValue(""), null);
  eq("a nonsense value is no date", colomboDayFromValue("08/10/2026"), null);
  eq("a date that does not exist is refused", colomboDayFromValue("2026-02-30"), null);
  eq("no date reads as an empty input", colomboDateValue(null), "");
}

const o = repo.openings()[0];
const [li, rs, dh, sc] = repo.strategies();
const today = colomboDayStart(Date.UTC(2026, 9, 8, 6, 0));
const lead = { byUserId: "u_lead", byRole: "ta_lead" as const, today };

console.log("\nThe lead puts TAs on strategies");
{
  const a = repo.addStrategyDoneBy({ openingId: o.id, strategyId: li.id, taId: "u_nuha", ...lead });
  eq("a row is made on the first assignment, dated that day", [a?.created, a?.added, a?.row.assignedAt, a?.row.doneBy], [true, true, today, ["u_nuha"]]);
  eq("it keeps the strategy's name", a?.row.strategyName, li.name);
  const b = repo.addStrategyDoneBy({ openingId: o.id, strategyId: li.id, taId: "u_imalsha", ...lead });
  eq("a second TA joins the same row, no second row", [b?.created, b?.added, b?.row.doneBy, repo.strategyAssignments(o.id).length], [false, true, ["u_nuha", "u_imalsha"], 1]);
  const c = repo.addStrategyDoneBy({ openingId: o.id, strategyId: li.id, taId: "u_nuha", ...lead });
  eq("the same TA twice is nothing", [c?.added, c?.row.doneBy.length], [false, 2]);
  eq("an unknown strategy is refused", repo.addStrategyDoneBy({ openingId: o.id, strategyId: "st_nope", taId: "u_nuha", ...lead }), null);
  repo.setStrategyActive(dh.id, false);
  eq("a retired strategy cannot be newly assigned", repo.addStrategyDoneBy({ openingId: o.id, strategyId: dh.id, taId: "u_nuha", ...lead }), null);
  repo.setStrategyActive(dh.id, true);

  const row = repo.strategyRow(o.id, li.id)!;
  repo.setStrategyAssignedDate(row.id, today - 86_400_000);
  eq("the lead can change the date assigned", repo.strategyAssignment(row.id)?.assignedAt, today - 86_400_000);
  repo.removeStrategyDoneBy(row.id, "u_imalsha");
  eq("a TA can be taken off", repo.strategyAssignment(row.id)?.doneBy, ["u_nuha"]);
  repo.removeStrategyDoneBy(row.id, "u_nuha");
  eq("a row left with a date still stays", !!repo.strategyAssignment(row.id), true);
  repo.setStrategyAssignedDate(row.id, null);
  repo.removeStrategyDoneBy(row.id, "u_nuha");
  eq("a row left with nothing on it goes", repo.strategyAssignment(row.id), undefined);
}

console.log("\nStriking a strategy through for a job");
{
  const mark = (n: boolean) => repo.setStrategyNotApplicable({ openingId: o.id, strategyId: sc.id, notApplicable: n, byUserId: "u_lead", byRole: "ta_lead" });
  eq("striking an untouched strategy makes a row", [mark(true), repo.strategyRow(o.id, sc.id)?.notApplicable, repo.strategyRow(o.id, sc.id)?.doneBy], [true, true, []]);
  eq("it has no assigned date", repo.strategyRow(o.id, sc.id)?.assignedAt, null);
  mark(false);
  eq("bringing it back removes the empty row", repo.strategyRow(o.id, sc.id), undefined);
  eq("bringing back one that was never struck is fine", mark(false), true);

  // A struck-through row that has a TA keeps its row when it is brought back.
  repo.addStrategyDoneBy({ openingId: o.id, strategyId: sc.id, taId: "u_nuha", ...lead });
  mark(true);
  mark(false);
  eq("a row with a TA on it stays when brought back", repo.strategyRow(o.id, sc.id)?.doneBy, ["u_nuha"]);
  repo.removeStrategyRow(repo.strategyRow(o.id, sc.id)!.id);
}

console.log("\nThe TA fills the row in and submits");
{
  repo.addStrategyDoneBy({ openingId: o.id, strategyId: rs.id, taId: "u_nuha", ...lead });
  repo.addStrategyDoneBy({ openingId: o.id, strategyId: dh.id, taId: "u_imalsha", ...lead });
  repo.setStrategyNotApplicable({ openingId: o.id, strategyId: sc.id, notApplicable: true, byUserId: "u_lead", byRole: "ta_lead" });
  const mine = repo.strategyRow(o.id, rs.id)!;
  const theirs = repo.strategyRow(o.id, dh.id)!;
  const struck = repo.strategyRow(o.id, sc.id)!;
  eq("before submitting, the lead has nothing from the TA", [mine.doneAt, mine.note, mine.submittedAt], [null, null, null]);

  const proof = { id: "stg_1", contentType: "image/png", size: 1234, addedAt: 5, addedBy: "u_nuha", submittedAt: null };
  eq("a proof is attached to the row", repo.addStrategyProof(mine.id, proof), true);
  eq("the lead cannot see it before the TA submits", proofsForLead(repo.strategyAssignment(mine.id)!).length, 0);
  eq("the TA sees their own pending proof", proofsVisibleTo(repo.strategyAssignment(mine.id)!, user("ta", { id: "u_nuha" })).length, 1);
  eq("another TA does not", proofsVisibleTo(repo.strategyAssignment(mine.id)!, user("ta", { id: "u_imalsha" })).length, 0);
  eq("a client does not", proofsVisibleTo(repo.strategyAssignment(mine.id)!, user("client")).length, 0);

  const taken = repo.submitStrategyRows({
    openingId: o.id,
    taId: "u_nuha",
    now: 1_000,
    rows: [
      { rowId: mine.id, doneAt: today, note: "Searched twice; found six." },
      { rowId: theirs.id, doneAt: today, note: "not mine to edit" },
      { rowId: struck.id, doneAt: today, note: "struck through" },
      { rowId: "sa_nope", doneAt: today, note: "x" },
    ],
  });
  eq("only their own row, not struck through, is taken in", taken, 1);
  const after = repo.strategyAssignment(mine.id)!;
  eq("what they wrote is on the row, stamped", [after.doneAt, after.note, after.submittedAt, after.submittedBy], [today, "Searched twice; found six.", 1_000, "u_nuha"]);
  eq("their proof is now the lead's to see", proofsForLead(after).map((p) => p.id), ["stg_1"]);
  eq("another TA's row is untouched", [repo.strategyAssignment(theirs.id)?.note, repo.strategyAssignment(theirs.id)?.submittedAt], [null, null]);
  eq("a struck-through row cannot be filled in", [repo.strategyAssignment(struck.id)?.note, repo.strategyAssignment(struck.id)?.submittedAt], [null, null]);

  const gone = repo.removeStrategyProof(mine.id, "stg_1");
  eq("a proof can be removed, and says which file to delete", [gone, repo.strategyAssignment(mine.id)?.proofs.length], ["stg_1", 0]);
  eq("removing one that is not there is nothing", repo.removeStrategyProof(mine.id, "stg_nope"), null);
}

console.log("\nThe table of a job");
{
  const lines = strategyTable(repo.strategies(), repo.strategyAssignments(o.id));
  eq("a line for every listed strategy", lines.length, repo.strategies().length);
  eq("in the list's order", lines.map((l) => l.strategy.name).slice(0, 3), DESK_STRATEGIES.slice(0, 3));
  eq("untouched strategies have no row", lines.find((l) => l.strategy.id === li.id)?.row, null);
  eq("touched ones carry theirs", lines.find((l) => l.strategy.id === rs.id)?.row?.doneBy, ["u_nuha"]);

  repo.setStrategyActive(rs.id, false);
  const kept = strategyTable(repo.strategies(), repo.strategyAssignments(o.id));
  eq("a retired strategy with a row stays on the table", kept.some((l) => l.strategy.id === rs.id), true);
  eq("a retired strategy with no row does not appear", kept.some((l) => l.strategy.id === li.id), true);
  repo.setStrategyActive(dh.id, false);
  const kept2 = strategyTable(repo.strategies(), repo.strategyAssignments(o.id));
  eq("a retired strategy with a row still stays", kept2.some((l) => l.strategy.id === dh.id && !!l.row), true);
  repo.setStrategyActive(rs.id, true);
  repo.setStrategyActive(dh.id, true);
}

console.log("\nProgress, with struck-through strategies left out");
{
  const rows = repo.strategyAssignments(o.id);
  // rs: Nuha, submitted done; dh: Imalsha, not done; sc: struck through.
  eq("two assigned, one done, one struck through", countsOf(rows), { assigned: 2, done: 1, notApplicable: 1 });
  const { groups, unstaffed } = plannerByTa(repo.openings(), repo.users(), rows);
  const nuha = groups.find((g) => g.ta.id === "u_nuha");
  eq("a TA's group counts only the rows they are on", nuha?.jobs.find((j) => j.opening.id === o.id)?.counts, { assigned: 1, done: 1, notApplicable: 0 });
  eq("TAs are listed by name", groups.map((g) => g.ta.name), [...groups.map((g) => g.ta.name)].sort((a, b) => a.localeCompare(b)));
  const activeTa = (id: string) => repo.users().some((u) => u.id === id && u.role === "ta" && u.isActive);
  eq("jobs with no active TA on them are listed apart", unstaffed.every((x) => !x.assignedTaIds.some(activeTa)), true);
  eq("and no job with a TA is listed there", groups.flatMap((g) => g.jobs.map((j) => j.opening.id)).every((jid) => !unstaffed.some((x) => x.id === jid)), true);
  repo.removeStrategyRow(repo.strategyRow(o.id, sc.id)!.id);
  eq("taking a row off the table removes it", repo.strategyRow(o.id, sc.id), undefined);
}

console.log("\nThe tables are in every list the Convex store needs");
{
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", p), "utf8");
  const list = (src: string, re: RegExp) => [...(src.match(re)?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
  const whole = list(read("src/data/prime.ts"), /WHOLE_TABLES = \[([\s\S]*?)\] as const/);
  const wholeBackend = list(read("convex/ta/tables.ts"), /new Set\(\[([\s\S]*?)\]\)/);
  eq("the app's whole-table list and the backend's agree", whole, wholeBackend);
  for (const t of ["strategies", "strategyAssignments"]) {
    eq(`${t} is loaded whole`, whole.includes(t), true);
    eq(`${t} has a model in convex/ta/model/tables.ts`, new RegExp(`\\b${t}:\\s*identity\\(`).test(read("convex/ta/model/tables.ts")), true);
    eq(`${t} is in the Convex schema`, new RegExp(`\\b${t}:\\s*defineTable`).test(read("convex/schema.ts")), true);
    eq(`${t} is empty in a blank store`, new RegExp(`\\b${t}:\\s*\\[\\]`).test(read("src/data/primeState.ts")), true);
  }
  eq("assignments go when their opening is deleted", /"strategyAssignments",\s*"by_opening",\s*"openingId"/.test(read("convex/ta/openingDelete.ts")), true);
  eq("and when it goes to the Bin", /"strategyAssignments",\s*\(r\) => r\.openingId === id/.test(read("src/data/store.ts")), true);
  eq("the notification type is in both places", [read("convex/ta/notifications.ts"), read("convex/schema.ts")].every((s) => s.includes('"strategy_assigned"')), true);
  eq("the model lists the row's nullable fields", /strategyAssignments:\s*identity\("strategyAssignments",\s*\[[^\]]*"doneAt"[^\]]*"submittedBy"/.test(read("convex/ta/model/tables.ts")), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
