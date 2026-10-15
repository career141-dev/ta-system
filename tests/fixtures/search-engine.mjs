import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import * as scorer from "../../convex/cvs/cvScoring.ts";
import { fallbackRequirements } from "../../convex/lib/jdParser.ts";
import { readOccupation } from "../../convex/lib/searchRoleEvidence.ts";

// Only IO is replaced: exercise the real orchestration, pool, filters and scorer.
globalThis.fetch = async () => { throw new Error("Unexpected network access in search test"); };
const req = { ...fallbackRequirements("Personal Assistant to CFO").requirements, requiredSkills: ["calendar management"], preferredSkills: [] };
req.searchOccupation = readOccupation(req, "personal assistant cfo");
const docs = [
  { _id: "exact", currentTitle: "Personal Assistant to CFO", skills: [], location: "Colombo", totalExperienceYears: 8, currentEmployer: "Example", industries: ["Manufacturing"] },
  ...Array.from({ length: 199 }, (_, i) => ({ _id: `word-${i}`, currentTitle: "Personal Assistant", skills: [], location: "Colombo", currentEmployer: "Example" })),
  ...Array.from({ length: 200 }, (_, i) => ({ _id: `vector-${i}`, currentTitle: "CFO", skills: ["calendar management"], location: "Colombo", totalExperienceYears: 15, currentEmployer: "Other" })),
];
let receivedIds = [];
let review = [];
let modelFails = false;
const here = (path) => new URL(path, import.meta.url).href;
mock.module(here("../../src/data/convex/backend.ts"), { namedExports: {
  keywordSearchMany: async () => docs.slice(0, 200).map(c => ({ candidateId: c._id, score: 1 })),
  candidateDocsByIds: async (_actor, ids) => { receivedIds = ids; return docs.filter(c => ids.includes(c._id)); },
  employerSearch: async () => docs.slice(0, 200).map(c => ({ candidateId: c._id, score: 1 })),
} });
mock.module(here("../../src/lib/embed.ts"), { namedExports: { embedQuery: async () => ({ ok: true, vectors: [[1]] }) } });
mock.module(here("../../src/lib/qdrantSearch.ts"), { namedExports: { searchVectors: async () => docs.slice(200).map(c => ({ candidateId: c._id, score: 0.99 })) } });
mock.module(here("../../src/lib/spend.ts"), { namedExports: { reserve: () => () => {}, maxModelCost: () => 0, modelCost: () => 0 } });
mock.module(here("../../src/lib/claudeBridge.ts"), { namedExports: { askBridge: async () => ({ ok: false }) } });
mock.module(here("../../convex/lib/jdParser.ts"), { namedExports: {
  extractConversationRequirements: async (_turns, opts) => {
    assert.equal(opts.roleAware, true);
    if (modelFails) throw new Error("model unavailable");
    return { requirements: req, usage: { model: "fake", promptTokens: 0, completionTokens: 0 } };
  },
} });
mock.module(here("../../convex/cvs/cvScoring.ts"), { namedExports: {
  ...scorer,
  scoreBatchWithLLM: async (candidates, _req, _task, opts) => {
    assert.equal(opts.roleAware, true);
    review = candidates;
    if (modelFails) throw new Error("model unavailable");
    return { evaluations: new Map(candidates.map(c => [c.index, { score: c.cv._id === "exact" ? 1 : 100, reason: "Verify skills" }])), usage: {} };
  },
} });
const { quickEngineSearch, engineSearch, cachedEngineSearch } = await import("../../src/lib/engineSearch.ts");
const criteria = { titles: ["CFO"], skills: [], industries: [], employers: [], excludeEmployers: [], locations: [], minExperience: null, maxExperience: null };
const quick = await quickEngineSearch("personal assistant cfo", criteria, 400);
assert.equal(receivedIds.length, 400, "both retrieval allocations survive");
assert.ok(quick.hits.some(h => h.candidateId === "exact"));
assert.equal(quick.interpretation.searchOccupation.targetOccupation, "personal assistant", "partial vocabulary hit does not replace complete role phrase");
assert.equal(quick.hits.find(h => h.candidateId === "exact").roleEvidence.kind, "current");
const full = await engineSearch("personal assistant cfo", criteria, 400);
for (const results of [quick, full]) {
  assert.equal(results.hits.length, 400);
  assert.equal(results.hits[0].candidateId, "exact", "CFO-support context must survive AI scoring and the 200 generic competitors");
  const firstBroad = results.hits.findIndex(h => h.roleEvidence.kind === "broader");
  assert.equal(firstBroad, 200, "all supported roles precede CFO-only profiles");
  const pages = Array.from({ length: 16 }, (_, i) => results.hits.slice(i * 25, (i + 1) * 25));
  assert.deepEqual(pages.flat(), results.hits, "pagination preserves engine order");
}
assert.equal(review.length, 20);
assert.equal(review.filter(c => c.roleEvidence.kind !== "broader").length, 10);
assert.equal(cachedEngineSearch("personal assistant cfo", criteria, 400), full, "profile opening uses the same cached result");
const impossibleLocation = await quickEngineSearch("personal assistant cfo", { ...criteria, locations: ["Impossible City"] }, 400);
assert.equal(impossibleLocation.hits.length, 0, "strict filters cannot fall back to everyone");
const impossibleSkill = await quickEngineSearch("personal assistant cfo", { ...criteria, skills: ["unlisted requirement"] }, 400, true);
assert.equal(impossibleSkill.hits.length, 0);
const employer = await quickEngineSearch("personal assistant cfo", { ...criteria, titles: ["Personal Assistant"], employers: ["Example"] }, 400, true);
assert.ok(employer.hits.length > 0);
assert.ok(employer.hits.every(h => !h.candidateId.startsWith("vector-")), "employer constraints remain enforced");
const referenceProfile = {
  version: 1,
  role: "Personal Assistant",
  alternativeTitles: ["Executive Assistant"],
  seniority: "mid",
  totalExperienceYears: 8,
  minYears: 6,
  maxYears: 11,
  coreSkills: ["calendar management"],
  supportingSkills: ["stakeholder coordination"],
  industries: ["Manufacturing"],
  education: [],
  sourceCandidateId: "exact",
};
const reference = await quickEngineSearch("Find candidates similar to this reference profile.", criteria, 400, false, referenceProfile);
assert.ok(!reference.hits.some(h => h.candidateId === "exact"), "the reference person is excluded from their own results");
assert.ok(reference.hits.some(h => h.candidateId.startsWith("word-")), "reference skills are preferences and do not exclude a comparable career");
assert.ok(reference.hits[0].roleEvidence.kind !== "broader", "comparable role evidence ranks before broad keyword similarity");
const salaryFields = ["salary", "notice", "availability", "nationality", "languages"];
// No new desk filtering: the existing desk criteria remain passed through.
const { deskCriteria } = await import("../../src/lib/engineSearch.ts");
const desk = Object.fromEntries(salaryFields.map(k => [k, `test-${k}`]));
for (const k of salaryFields) assert.equal(deskCriteria({ ...criteria, ...desk })[k], desk[k]);
modelFails = true;
const unavailable = await engineSearch("Personal Assistant to CFO", criteria, 400);
assert.equal(unavailable.hits.findIndex(h => h.roleEvidence.kind === "broader"), 200);
const pageSource = readFileSync(new URL("../../src/app/database/results/page.tsx", import.meta.url), "utf8");
assert.ok(pageSource.includes("if (engineRanked) return (engineOrder.get(a.candidate.id)"), "page sorting must retain engine order");
console.log("Actual engine quick/full, retrieval, filtering, review, cache and model-failure tests passed.");
