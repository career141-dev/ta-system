import assert from "node:assert/strict";
import { workdayErrorMessage } from "../src/lib/workdayErrors";

const stopped = new Error(
  "Convex refused ta/workdays:addPosition: [Request ID: abc123] Server Error Uncaught Error: The workday clock has stopped. Add Follow-up or Add-on positions.\n    at handler (../../convex/ta/workdays.ts:1522:25)",
);

assert.equal(
  workdayErrorMessage(stopped, "addPosition"),
  "Your workday was completed when the 100% EOD email was sent. You cannot add another 100% position today. Choose Follow-up or Add-on only for returning work; otherwise, add the position on your next workday.",
);
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
