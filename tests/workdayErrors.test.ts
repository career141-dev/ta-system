import assert from "node:assert/strict";
import { workdayErrorMessage } from "../src/lib/workdayErrors";
import { MAX_100_MESSAGE, count100 } from "../src/lib/workdayRequirements";

assert.equal(
  workdayErrorMessage(
    new Error(`Convex refused ta/workdays:addPosition: [Request ID: abc123] Server Error Uncaught Error: ${MAX_100_MESSAGE}\n    at handler (../../convex/ta/workdays.ts:1522:25)`),
    "addPosition",
  ),
  MAX_100_MESSAGE,
);
assert.equal(count100([{ workType: "100%" }, { workType: "Follow-up" }, { workType: "100%" }]), 2);
assert.match(MAX_100_MESSAGE, /at most 5 100% positions/);
assert.equal(
  workdayErrorMessage(
    new Error(
      "Convex refused ta/workdays:addPosition: [Request ID: def456] Server Error Uncaught Error: A workday supports at most ten positions.\n    at handler (../../convex/ta/workdays.ts:1519:13)",
    ),
    "addPosition",
  ),
  "A workday supports at most ten positions.",
);
assert.equal(
  workdayErrorMessage(new Error("Convex refused ta/workdays:addPosition: HTTP 500"), "addPosition"),
  "Could not save. Try again. If this continues, ask an admin for help.",
);

console.log("  ok  workday forms show instructions without Convex request details");
