import { strict as assert } from "node:assert";
import {
  OPENING_BUCKETS,
  OPENING_STATUS_LABEL,
  statusMatchesBucket,
  type OpeningStatus,
} from "@/lib/openingStatus";

const statuses: OpeningStatus[] = ["open", "on_hold", "filled", "closed"];

assert.equal(OPENING_STATUS_LABEL.filled, "Placed");
assert.equal(OPENING_STATUS_LABEL.closed, "Closed / Lost");
assert.deepEqual(
  OPENING_BUCKETS.slice(-2),
  [
    { key: "placed", label: "Placed" },
    { key: "closed", label: "Closed / Lost" },
  ],
);
assert.deepEqual(
  statuses.filter((status) => statusMatchesBucket(status, "placed")),
  ["filled"],
  "Placed contains successful fills only",
);
assert.deepEqual(
  statuses.filter((status) => statusMatchesBucket(status, "closed")),
  ["closed"],
  "Closed / Lost excludes successful fills",
);

console.log("\n5 passed, 0 failed\n");
