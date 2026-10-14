import assert from "node:assert/strict";
import { compareSearchCandidates, mergeSearchPool, occupationTitle, quickRolePhrase, readOccupation, roleEvidence, roleMatches, searchReviewPool } from "../convex/lib/searchRoleEvidence";
import { scoreCandidateAgainstRequirements, searchReviewEvidence, scoreBatchWithLLM } from "../convex/cvs/cvScoring";
import { answerInProcess } from "../convex/lib/claudeFirst";
import { fallbackRequirements, conversationReply, type SearchRequirements } from "../convex/lib/jdParser";

const requirements = (title: string): SearchRequirements => ({ ...fallbackRequirements(title).requirements, requiredSkills: [], preferredSkills: [], title });
const req = requirements("Personal Assistant to CFO");
req.requiredSkills = ["calendar management", "executive support"];
const intent = readOccupation(req, "personal assistant cfo");
assert.equal(intent.targetOccupation, "personal assistant");
assert.equal(intent.reportingContext, "CFO");
assert.deepEqual(intent.explicitSkills, []);
assert.equal(intent.inferredSkills.length, 2);
const searchReq = { ...req, requiredSkills: intent.explicitSkills, preferredSkills: intent.inferredSkills };
const profiles = [
  { _id: "cfo", currentTitle: "CFO", totalExperienceYears: 18, skills: ["calendar management", "executive support"], vectorScore: 0.99 },
  { _id: "pa", currentTitle: "Personal Assistant to CFO", totalExperienceYears: 9, skills: ["communication"] },
  { _id: "ea", currentTitle: "Executive Assistant to CEO", totalExperienceYears: 8, skills: [] },
  { _id: "past", currentTitle: "Office Manager", skills: [], jobHistory: [{ title: "Personal Assistant", startDate: "2017", endDate: "2021" }] },
];
const ranked = profiles.map((cv, i) => scoreCandidateAgainstRequirements(cv, searchReq, i, { pastTitles: true, searchOccupation: intent })).sort((a, b) => compareSearchCandidates(a, b));
assert.equal(ranked.at(-1)?.cv._id, "cfo", "CFO remains present but below supported roles");
assert.equal(ranked.find(c => c.cv._id === "pa")?.titleScore, 100);
assert.equal(ranked.find(c => c.cv._id === "ea")?.titleScore, 100);
assert.equal(ranked.find(c => c.cv._id === "past")?.roleEvidence?.kind, "previous");
assert.equal(ranked.find(c => c.cv._id === "cfo")?.titleScore, 0);
const reorderedByAi = [...ranked].sort((a, b) => compareSearchCandidates(a, b, a.cv._id === "cfo" ? 100 : 1, b.cv._id === "cfo" ? 100 : 1));
assert.equal(reorderedByAi.at(-1)?.cv._id, "cfo", "AI cannot undo occupation ordering");
assert.deepEqual([...ranked].sort((a, b) => compareSearchCandidates(a, b)).map(c => c.cv._id), ranked.map(c => c.cv._id), "missing model output retains deterministic order");

for (const [query, good, bad] of [
  ["Executive Assistant to CEO", "Personal Assistant to CEO", "CEO"],
  ["Assistant Accountant", "Assistant Accountant", "Accountant"],
  ["Assistant Finance Manager", "Assistant Finance Manager", "Finance Manager"],
  ["CFO", "Chief Financial Officer", "Personal Assistant to CFO"],
]) {
  const occupation = readOccupation(requirements(query), query);
  assert.equal(roleMatches(good, occupation), true, `${query}: ${good}`);
  assert.equal(roleMatches(bad, occupation), false, `${query}: not ${bad}`);
}
assert.equal(occupationTitle("Assistant Accountant"), "assistant accountant");
assert.equal(quickRolePhrase("Find a Personal Assistant to CFO with Excel"), "Personal Assistant to CFO");
assert.equal(roleMatches("Personal Assistant CFO", intent), true);
assert.equal(roleMatches("Senior Executive Assistant to CEO", intent), true);
assert.equal(roleMatches("Executive PA / Secretary to CEO", intent), true);
assert.equal(roleEvidence({ currentTitle: "CFO", summary: "Reporting to CFO. Hires personal assistants." }, intent)?.kind, "broader");
assert.equal(roleEvidence({ currentTitle: "Manager", summary: "Previously worked as a Personal Assistant to CFO." }, intent)?.kind, "previous");
assert.equal(roleEvidence({ jobHistory: [{ title: "Executive Assistant", endDate: "Present" }] }, intent)?.kind, "current");

const synonyms = readOccupation({ ...requirements("Software Developer"), occupationSynonyms: ["Software Engineer"] }, "Software Developer");
assert.equal(roleMatches("Software Engineer", synonyms), true);
const dangerousAlternatives = readOccupation({ ...requirements("Assistant Accountant"), occupationSynonyms: ["Accountant", "Finance Manager"] }, "Assistant Accountant");
assert.equal(roleMatches("Accountant", dangerousAlternatives), false);
const explicit = readOccupation({ ...req, requiredSkills: ["Excel", "calendar management"] }, "Personal Assistant to CFO must have Excel");
assert.deepEqual(explicit.explicitSkills, ["Excel"]);
assert.deepEqual(explicit.inferredSkills, ["calendar management"]);
assert.deepEqual(readOccupation(req, "PA", ["SAP"]).explicitSkills, ["SAP"]);
const noRole = readOccupation({ ...requirements("People at Example"), searchOccupation: { targetOccupation: null, equivalentTitles: [], reportingContext: null, explicitSkills: [], inferredSkills: [] } }, "People at Example");
assert.equal(roleEvidence(profiles[0], noRole), undefined);
assert.equal(readOccupation(requirements("Everyone at Example"), "Everyone at Example").targetOccupation, null);

const vectors = Array.from({ length: 200 }, (_, i) => `vector-${i}`);
const words = Array.from({ length: 250 }, (_, i) => `keyword-${i}`);
assert.equal(mergeSearchPool(words, vectors).length, 400);
assert.equal(mergeSearchPool(words, vectors)[0], "keyword-0");
assert.ok(mergeSearchPool(["exact-assistant", ...words], vectors).includes("exact-assistant"));
assert.equal(mergeSearchPool(["same", "same"], ["same", "other"]).length, 2);
const keywordOnly = scoreCandidateAgainstRequirements(profiles[1], searchReq, 0, { searchOccupation: intent });
const zeroVector = scoreCandidateAgainstRequirements({ ...profiles[1], vectorScore: 0 }, searchReq, 0, { searchOccupation: intent });
assert.ok(keywordOnly.overallScore > zeroVector.overallScore, "missing vector evidence does not dilute keyword-only matches");

const protectedCandidates = Array.from({ length: 15 }, (_, index) => ({ ...ranked.find(c => c.cv._id === "pa")!, index, skillScore: index, overallScore: 20 + index }));
const uncertain = Array.from({ length: 20 }, (_, index) => ({ ...ranked.find(c => c.cv._id === "cfo")!, index: 100 + index }));
const review = searchReviewPool([...protectedCandidates, ...uncertain]);
assert.equal(review.length, 20);
assert.equal(review.filter(c => c.index < 100).length, 10);
assert.equal(review[0].index, 0, "low-skill supported profiles are protected");
assert.equal(new Set(review.map(c => c.index)).size, 20);
assert.equal(searchReviewPool(uncertain).length, 20, "unused supported allocation is refilled");
assert.equal(searchReviewPool(protectedCandidates).length, 15);

const serialized = searchReviewEvidence({ ...keywordOnly, cv: { ...keywordOnly.cv, fullName: "Private Name", summary: "Personal assistant. private@example.test +94111234567", rawText: "FULL CV SECRET", skills: [...Array.from({ length: 14 }, (_, i) => `other-${i}`), "calendar management"], jobHistory: [2010, 2024, 2018, 2022].map(y => ({ title: "Assistant", startDate: `${y}`, endDate: `${y + 1}` })) } }, searchReq);
assert.equal(serialized.skills.length, 12);
assert.equal(serialized.skills[0], "calendar management");
assert.equal(serialized.recentRoles.length, 3);
assert.equal(serialized.recentRoles[0].startDate, "2024");
assert.ok(!JSON.stringify(serialized).includes("Private Name"));
assert.ok(!JSON.stringify(serialized).includes("private@example.test"));
assert.ok(!JSON.stringify(serialized).includes("94111234567"));
assert.ok(!JSON.stringify(serialized).includes("FULL CV SECRET"));

const legacy = scoreCandidateAgainstRequirements(profiles[1], req, 0);
assert.equal(legacy.roleEvidence, undefined, "shared applicant scoring remains opt-in");
assert.ok(scoreCandidateAgainstRequirements(profiles[0], req, 0).titleScore > 0, "legacy scorer behavior unchanged");
const parsed = conversationReply(JSON.stringify({ ...req, searchOccupation: intent }), ["personal assistant cfo"]);
assert.deepEqual(parsed?.searchOccupation, intent);
assert.equal(conversationReply(JSON.stringify({ ...req, searchOccupation: {} }), [req.title])?.searchOccupation, undefined, "incomplete occupation metadata falls back to the title");
process.env.OPENROUTER_API_KEY = "test-placeholder-not-a-secret";
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
answerInProcess(async () => JSON.stringify({ evaluations: [{ id: 0, reason: "No score" }, { id: 7, score: 64, reason: "Verify skills" }] }));
const reviewed = await scoreBatchWithLLM([keywordOnly, { ...keywordOnly, index: 7 }], searchReq, "search_ranking", { roleAware: true });
assert.equal(reviewed.evaluations.has(0), false, "incomplete AI evaluation must not replace deterministic score with a default 50");
assert.equal(reviewed.evaluations.get(7)?.score, 64);
console.log("Search occupation, pool, scoring, review, and privacy regressions passed.");
