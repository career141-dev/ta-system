import assert from "node:assert/strict";
import type { Application, ReviewRound, User } from "@/data/types";
import {
  levelSlot,
  masterSheetActorIds,
  masterSheetApplicationsForUser,
  masterSheetRoundsForApplications,
  masterSheetStatusFields,
  roundSlot,
  uniqueSubmitted,
} from "@/lib/masterSheet";
import { resolveTaPerformanceQuestion, taPerformanceSpec } from "@/lib/reportAsk";
import { sanitizeSpec } from "@/lib/reportSpec";

const rounds = [
  {
    kind: "director" as const,
    setNumber: 1,
    sentAt: 100,
    dispatch: "sent" as const,
    applicationIds: ["a", "b"],
    decisions: [{ applicationId: "a", outcome: "shortlisted" as const, note: null, confirmed: true }],
  },
  {
    kind: "director" as const,
    setNumber: 1,
    sentAt: 200,
    dispatch: "sent" as const,
    applicationIds: ["a", "b", "c"],
    decisions: [
      { applicationId: "a", outcome: "hold" as const, note: null, confirmed: true },
      { applicationId: "b", outcome: "shortlisted" as const, note: null, confirmed: true },
    ],
  },
  {
    kind: "client" as const,
    setNumber: 1,
    sentAt: 300,
    dispatch: "sent" as const,
    applicationIds: ["b"],
    decisions: [{ applicationId: "b", outcome: "shortlisted" as const, note: null, confirmed: true }],
  },
  {
    kind: "director" as const,
    setNumber: 2,
    sentAt: 400,
    dispatch: "held" as const,
    applicationIds: ["d"],
    decisions: [],
  },
];

assert.deepEqual(levelSlot([{ n: 1, at: 20 }, { n: 1, at: 10 }], [{ level: 1 }, { level: 2 }, { level: 1 }], 1), {
  at: 10,
  count: 2,
});

assert.deepEqual(roundSlot(rounds, "director", 1), { at: 100, count: 3, shortlisted: 1 });
assert.deepEqual(roundSlot(rounds, "client", 1), { at: 300, count: 1, shortlisted: 1 });
assert.equal(uniqueSubmitted(rounds), 3, "held rounds and duplicate candidates are not counted");
assert.deepEqual(roundSlot([
  { ...rounds[0]!, decisions: [{ ...rounds[0]!.decisions[0]!, decidedAt: 105 }] },
  { ...rounds[1]!, decisions: [
    { ...rounds[1]!.decisions[0]!, decidedAt: 205 },
    rounds[1]!.decisions[1]!,
  ] },
] as ReviewRound[], "director", 1, 150), {
  at: 200, count: 3, shortlisted: 0, dateUnknown: 1,
}, "a period uses sent and decision dates without inventing an old decision date");

assert.deepEqual(masterSheetStatusFields("active", 50, 40, 100), {
  status: "open", backendStatus: "active", closedAt: null,
});
assert.deepEqual(masterSheetStatusFields("hold", 50, 40, 100), {
  status: "on_hold", backendStatus: "on_hold", closedAt: null,
});
assert.deepEqual(masterSheetStatusFields("lost", null, null, 100), {
  status: "closed", backendStatus: "cancelled", closedAt: 100,
});
assert.deepEqual(masterSheetStatusFields("filled", 50, 40, 100), {
  status: "filled", backendStatus: "filled", closedAt: 50,
});

const personalApplications = masterSheetApplicationsForUser([
  { id: "a", ownerTaId: "ta-1" },
  { id: "b", ownerTaId: "ta-2" },
  { id: "c", ownerTaId: null },
] as Application[], "ta-1");
assert.deepEqual(personalApplications.map((application) => application.id), ["a"], "a TA sees only candidates they own");

const personalRounds = masterSheetRoundsForApplications(
  rounds as unknown as ReviewRound[],
  new Set(["a"]),
);
assert.deepEqual(
  personalRounds.map((round) => round.applicationIds),
  [["a"], ["a"]],
  "a combined review email is reduced to this TA's candidates",
);
assert.deepEqual(
  personalRounds.flatMap((round) => round.decisions.map((decision) => decision.applicationId)),
  ["a", "a"],
  "another TA's shortlist decisions do not enter the personal sheet",
);

const people = [
  { id: "ta-1", name: "Tushini Perera", role: "ta" },
  { id: "ta-2", name: "Nimali Silva", role: "ta" },
  { id: "lead", name: "Lead User", role: "ta_lead" },
] as User[];
const opening = { assignedTaIds: ["ta-1", "ta-2"] };
assert.deepEqual(masterSheetActorIds(opening, [
  { ownerTaId: "ta-1" }, { ownerTaId: null },
] as Application[], [{ addedBy: "ta-2" }, { addedBy: "lead" }] as never[], people),
["ta-1", "ta-2", null], "assigned TAs stay separate and unowned work has a row");
assert.deepEqual(masterSheetActorIds({ assignedTaIds: [] }, [], [], people), [null],
  "a new unassigned job appears immediately");
assert.deepEqual(masterSheetActorIds({ assignedTaIds: ["ta-2"] },
  [{ ownerTaId: "ta-1" }] as Application[], [], people), ["ta-2", "ta-1"],
  "a former TA remains named while they own work");
const named = resolveTaPerformanceQuestion("Show me Tushini's progress", people);
assert.equal(named.kind, "found");
if (named.kind === "found") assert.equal(named.user.id, "ta-1");
assert.equal(resolveTaPerformanceQuestion("Show me progress of active jobs", people).kind, "other");
assert.equal(resolveTaPerformanceQuestion("Show me Maya's progress", people).kind, "unknown");
assert.equal(taPerformanceSpec("ta-1", "month").subjectTaId, "ta-1");
const saved = sanitizeSpec({ ...taPerformanceSpec("ta-1"), groupBy: "ta", metrics: [
  { field: "valuePlaced", agg: "sum" }, { field: "cvsSent", agg: "sum" },
] }, taPerformanceSpec("ta-1"));
assert.equal(saved.subjectTaId, "ta-1", "a saved performance report keeps its resolved TA");
assert.deepEqual(saved.metrics, [{ field: "cvsSent", agg: "sum" }], "shared job values cannot be summed across TA rows");

console.log("master sheet metrics passed");
