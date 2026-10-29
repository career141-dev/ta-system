import assert from "node:assert/strict";
import { assignedJobDestination } from "../convex/ta/stages";

for (const stage of ["new_cvs", "matched_candidates", "ta_shortlist", "ai_call"])
  assert.equal(assignedJobDestination(stage), "move", stage);
assert.equal(assignedJobDestination("follow_up"), "already");
for (const stage of ["second_shortlist", "director_shortlist", "client_review", "interview", "offer", "placed", "rejected", "unresponsive", "unknown"])
  assert.equal(assignedJobDestination(stage), "protected", stage);
console.log("Destination stage protection passed.");
