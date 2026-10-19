import assert from "node:assert/strict";
import type { Application, ReviewRound } from "@/data/types";
import {
  levelSlot,
  masterSheetApplicationsForUser,
  masterSheetRoundsForApplications,
  masterSheetStatusFields,
  roundSlot,
  uniqueSubmitted,
} from "@/lib/masterSheet";

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

console.log("master sheet metrics passed");
