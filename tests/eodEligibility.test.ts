import assert from "node:assert/strict";
import { isEodCandidateEligible } from "@/lib/eodEligibility";

const base = { stage: "director_review", ownerTaId: "ta", isAddOn: false, lastStageChangedAt: 200 };

assert.equal(isEodCandidateEligible(base, { taId: "ta", workType: "100%", sessionStart: 100 }), true);
assert.equal(isEodCandidateEligible(base, { taId: "ta", workType: "Follow-up", sessionStart: 100 }), true);
assert.equal(isEodCandidateEligible({ ...base, ownerTaId: "other" }, { taId: "ta", workType: "Follow-up", sessionStart: 100 }), false);
assert.equal(isEodCandidateEligible({ ...base, stage: "ta_follow_up" }, { taId: "ta", workType: "Follow-up", sessionStart: 100 }), false);
assert.equal(isEodCandidateEligible({ ...base, stage: "second_shortlist" }, { taId: "ta", workType: "Follow-up", sessionStart: 100 }), true);

assert.equal(isEodCandidateEligible({ ...base, isAddOn: true }, { taId: "ta", workType: "Add-on", sessionStart: 100 }), true);
assert.equal(isEodCandidateEligible(base, { taId: "ta", workType: "Add-on", sessionStart: 100 }), false);
assert.equal(isEodCandidateEligible({ ...base, isAddOn: true, lastStageChangedAt: 99 }, { taId: "ta", workType: "Add-on", sessionStart: 100 }), false);
assert.equal(isEodCandidateEligible({ ...base, isAddOn: true }, { taId: "ta", workType: "Add-on", sessionStart: null }), false);

console.log("Mode-aware EOD candidate eligibility passed.");
