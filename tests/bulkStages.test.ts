import assert from "node:assert/strict";
import { bulkStages } from "@/lib/bulkStages";

assert.deepEqual(bulkStages([], true, true), []);
assert.deepEqual(bulkStages(["matched", "new_cv"], false, false), ["ta_follow_up", "rejected", "dropped_out"]);
assert.deepEqual(bulkStages(["ta_follow_up"], false, false), ["director_review", "rejected", "dropped_out"]);
assert.deepEqual(bulkStages(["director_review"], false, false), ["ta_follow_up", "rejected", "dropped_out"]);
assert.ok(bulkStages(["director_review"], true, false).includes("director_shortlist"));
assert.ok(!bulkStages(["director_shortlist"], true, false).includes("client_shortlist"));
assert.ok(bulkStages(["director_shortlist"], false, true).includes("client_shortlist"));
assert.deepEqual(bulkStages(["client_shortlist", "interview", "offer"], true, true), ["rejected", "dropped_out"], "milestones requiring details keep their dedicated forms");
assert.deepEqual(bulkStages(["matched", "ta_follow_up", "ta_follow_up"], false, false), ["ta_follow_up", "director_review", "rejected", "dropped_out"], "mixed selections offer the union once; each move still checks its own transition");
console.log("Bulk stage options passed.");
