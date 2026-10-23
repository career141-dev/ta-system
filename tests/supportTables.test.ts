import assert from "node:assert/strict";
import { can } from "@/lib/auth";
import { supportTableRows } from "@/lib/supportTables";
import type { LinkVaultEntry, Role, User } from "@/data/types";

const user = (role: Role, isActive = true) => ({ id: "support", role, isActive } as User);
const support = user("ta_support");
const row = (id: string, openingId: string, addedBy: string, level: number, createdAt: number) => ({
  id, openingId, addedBy, level, createdAt, name: `Profile ${id}`, company: "Example Ltd",
} as LinkVaultEntry);
const rows = [row("a", "one", "ta-a", 1, 1), row("b", "one", "ta-b", 2, 3), row("c", "two", "ta-c", 1, 2)];
assert.deepEqual(supportTableRows(support, rows, { openingId: "one" }).map(r => r.id), ["b", "a"],
  "Support reads every TA's rows without an opening assignment");
assert.deepEqual(supportTableRows(support, rows, { openingId: "two" }).map(r => r.id), ["c"],
  "Another position is readable without requesting job access");
assert.deepEqual(supportTableRows(support, rows, { openingId: "one", taId: "ta-a", level: "1", q: "EXAMPLE" }).map(r => r.id), ["a"]);
assert.equal(supportTableRows(support, rows, { openingId: "one", taId: "ta-c" }).length, 0);
for (const role of ["ta", "viewer", "client", "admin", "director", "ta_lead", "ops"] as Role[]) {
  assert.equal(can(user(role), "tables.readAll").ok, false);
  assert.throws(() => supportTableRows(user(role), rows, { openingId: "one" }));
}
assert.throws(() => supportTableRows(user("ta_support", false), rows, { openingId: "one" }), /deactivated/);
for (const capability of ["opening.read", "opening.act", "opening.sourcing", "opening.manage", "user.manage", "strategy.assign", "decide.director", "decide.client"] as const) {
  assert.equal(can(support, capability).ok, false, `${capability} is not granted by global table reading`);
}
assert.equal(can(support, "opening.sourcing", { assignment: { role: "supporting_recruiter" } as any, ownerTaId: "another-ta" }).ok, false);
console.log("TA Support reads cross-position tables without gaining assignments, write access or reviewer permissions.");
