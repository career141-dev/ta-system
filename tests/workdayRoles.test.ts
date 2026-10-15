import assert from "node:assert/strict";
import { canReviewWorkdays, canViewWorkday } from "../src/lib/workdayRoles";

for (const role of ["ta", "ta_support", "ta_lead", "admin", "director"]) assert.equal(canViewWorkday(role), true, role);
for (const role of ["ta_lead", "admin", "director"]) assert.equal(canReviewWorkdays(role), true, role);
for (const role of ["ta", "ta_support", "ops", "client", "viewer", "unknown"]) assert.equal(canReviewWorkdays(role), false, role);
for (const role of ["ops", "client", "viewer", "unknown"]) assert.equal(canViewWorkday(role), false, role);
console.log("Worker and reviewer panels cover the five intended roles without exposing workdays to other seats.");
