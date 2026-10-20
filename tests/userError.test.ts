import assert from "node:assert/strict";
import { isTechnicalMessage, safeErrorMessage } from "../src/lib/userError";

const fallback = "That change could not be saved. Try again.";

assert.equal(
  safeErrorMessage(new Error("Only the TA Lead for this opening can approve this request."), fallback),
  "Only the TA Lead for this opening can approve this request.",
);
assert.equal(
  safeErrorMessage(
    new Error("Convex refused ta/openingAccess:approve: [Request ID: abc123] Server Error Uncaught Error: internal failure"),
    fallback,
  ),
  fallback,
);
assert.equal(safeErrorMessage(new Error("fetch failed: ECONNREFUSED https://api.example.test"), fallback), fallback);
assert.equal(safeErrorMessage(new Error("The backend answered HTTP 503"), fallback), fallback);
assert.equal(safeErrorMessage(new Error("C:\\server\\jobs.ts:42 failed"), fallback), fallback);
assert.equal(safeErrorMessage(new Error("Invalid API key: sk-example"), fallback), fallback);
assert.equal(safeErrorMessage(null, fallback), fallback);
assert.equal(isTechnicalMessage("Please choose an opening."), false);
assert.equal(isTechnicalMessage("Request ID: abc123"), true);

console.log("  ok  user-facing errors preserve useful instructions and hide technical details");
