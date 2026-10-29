/** Native strategy cards use the same rows and writers as the website. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-strategies-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileStrategies } = await import("@/lib/mobile/strategies");
const { acceptStrategies, submitStrategies, removeStrategyPicture } = await import("@/lib/openings/strategyWrites");
repo.reset();

const deps = {
  convexMutation: async <T,>() => undefined as T,
  markTablesStale: () => undefined,
};

function assignedRow() {
  repo.reset();
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta)[0]!;
  const strategy = repo.strategies(true)[0]!;
  const lead = repo.users().find((user) => user.role === "ta_lead" && user.isActive)!;
  const added = repo.addStrategyDoneBy({ openingId: opening.id, strategyId: strategy.id, taId: ta.id, byUserId: lead.id, byRole: lead.role, today: Date.now(), now: Date.now() });
  assert(added?.row);
  return { ta, opening, strategy, row: added.row };
}

test("the payload turns the website table into scoped mobile cards", () => {
  const { ta, opening, row } = assignedRow();
  const payload = mobileStrategies(ta, opening.id);
  assert(payload);
  assert.equal(payload.context.openingId, opening.id);
  assert.equal(payload.pendingCount, 1);
  assert.equal(payload.rows.find((item) => item.rowId === row.id)?.mine, true);
  assert.equal(payload.rows.find((item) => item.rowId === row.id)?.acceptance, "pending");
});

test("accept and submit share the website rules and messages", async () => {
  const { ta, opening, row } = assignedRow();
  const accepted = acceptStrategies(ta, opening.id, deps);
  assert.equal(accepted.ok, true);
  assert.match(accepted.message, /^Accepted 1 strategy/);
  const submitted = await submitStrategies(ta, opening.id, [{ rowId: row.id, used: true, date: "", note: "Contacted the target list." }], deps);
  assert.equal(submitted.ok, true);
  assert.match(submitted.message, /^Submitted 1 strategy/);
  assert.equal(repo.strategyAssignment(row.id)?.note, "Contacted the target list.");
});

test("another person cannot remove a TA's proof", async () => {
  const { ta, row } = assignedRow();
  repo.addStrategyProof(row.id, { id: "proof-x", contentType: "image/jpeg", size: 100, addedAt: Date.now(), addedBy: ta.id, submittedAt: null });
  const other = repo.users().find((user) => user.role === "ta" && user.id !== ta.id && user.isActive)!;
  const result = await removeStrategyPicture(other, row.id, "proof-x", deps);
  assert.equal(result.ok, false);
});
