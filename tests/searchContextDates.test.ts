import assert from "node:assert/strict";
import { readOccupation, roleEvidence, compareSearchCandidates, searchEvidenceReason } from "../convex/lib/searchRoleEvidence";
import { fallbackRequirements } from "../convex/lib/jdParser";
import { scoreCandidateAgainstRequirements } from "../convex/cvs/cvScoring";

const now = new Date("2026-10-14T00:00:00Z");
const req = { ...fallbackRequirements("Personal Assistant to CFO").requirements, requiredSkills: [], preferredSkills: [] };
const intent = readOccupation(req, req.title);
const exact = { _id: "exact", currentTitle: "Personal Assistant to CFO", skills: [], jobHistory: [{ title: "Personal Assistant to CFO", startDate: "2023", endDate: "Present" }] };
const general = { _id: "general", currentTitle: "Executive Assistant to CEO", skills: ["Excel"], vectorScore: 0.99 };
const pastCfo = { _id: "past-cfo", currentTitle: "Executive Assistant to CEO", jobHistory: [{ title: "Executive Assistant to CEO", startDate: "2024", endDate: "Present" }, { title: "PA to Chief Financial Officer", startDate: "2019", endDate: "2023" }] };
const restaurant = { _id: "ended", currentTitle: "Personal Assistant", currentEmployer: "Example Restaurant", jobHistory: [{ title: "Personal Assistant", company: "Example Restaurant", startDate: "2018", endDate: "2021" }] };

assert.equal(roleEvidence(exact, intent, now)?.matchedReportingContext, "CFO");
assert.equal(roleEvidence(general, intent, now)?.matchedReportingContext, undefined);
assert.equal(roleEvidence(pastCfo, intent, now)?.kind, "previous");
assert.equal(roleEvidence(pastCfo, intent, now)?.title, "PA to Chief Financial Officer");
assert.equal(roleEvidence(pastCfo, intent, now)?.matchedReportingContext, "CFO");
assert.equal(roleEvidence(restaurant, intent, now)?.kind, "previous");
assert.equal(roleEvidence(restaurant, intent, now)?.label, "Relevant previous role");
assert.equal(roleEvidence({ currentTitle: "CFO", summary: "Managed a personal assistant" }, intent, now)?.kind, "broader");
assert.equal(roleEvidence({ currentTitle: "PA", currentEmployer: "CFO Services" }, intent, now)?.matchedReportingContext, undefined);

// Same title at another employer must not invalidate the current role.
assert.equal(roleEvidence({ ...restaurant, currentEmployer: "New Employer" }, intent, now)?.kind, "current");
assert.equal(roleEvidence({ ...restaurant, jobHistory: [...restaurant.jobHistory, { title: "Personal Assistant", company: "Example Restaurant", startDate: "2024", endDate: "Till date" }] }, intent, now)?.kind, "current");
assert.equal(roleEvidence({ ...restaurant, jobHistory: [{ title: "Personal Assistant", startDate: "2018", endDate: "03/2021" }] }, intent, now)?.kind, "previous");
assert.equal(roleEvidence({ ...restaurant, jobHistory: [{ title: "Personal Assistant", startDate: "2030", endDate: "Present" }] }, intent, now)?.kind, "broader");
assert.equal(roleEvidence({ ...restaurant, jobHistory: [{ title: "Personal Assistant", startDate: "2024", endDate: "2026" }] }, intent, now)?.kind, "current", "year-only end includes December");
assert.equal(roleEvidence({ ...exact, jobHistory: [{ title: "Personal Assistant to Chief Financial Officer", startDate: "2018", endDate: "2021" }] }, intent, now)?.kind, "previous", "expanded acronym still identifies the same ended role");

const editedQuick = readOccupation({ ...req, title: "Personal Assistant" }, "personal assistant cfo");
assert.equal(editedQuick.reportingContext, "cfo", "title chips do not erase context from the quick pass");
const modelRead = readOccupation({ ...req, searchOccupation: { ...intent, targetOccupation: "Personal Assistant", reportingContext: "CFO" } }, req.title);
assert.equal(modelRead.reportingContext, "CFO");
assert.equal(readOccupation({ ...req, searchOccupation: { ...intent, reportingContext: null } }, "PA to CFO. Any executive is okay now").reportingContext, null, "explicit model context removal stays removed");

const docs = [general, restaurant, pastCfo, exact, ...Array.from({ length: 110 }, (_, i) => ({ ...general, _id: `general-${i}` }))];
const score = (doc: typeof docs[number], index: number) => scoreCandidateAgainstRequirements(doc, req, index, { pastTitles: true, searchOccupation: intent });
const ranked = docs.map(score).sort((a, b) => compareSearchCandidates(a, b));
assert.equal(ranked[0].cv._id, "exact");
assert.equal(ranked[1].cv._id, "past-cfo");
const misleadingAi = docs.map(score).sort((a, b) => compareSearchCandidates(a, b, a.cv._id === "exact" ? 1 : 100, b.cv._id === "exact" ? 1 : 100));
assert.ok(misleadingAi.findIndex(c => c.cv._id === "exact") < misleadingAi.findIndex(c => c.cv._id === "general"), "AI cannot bury a supported CFO assistant below generic assistants");
assert.ok(searchEvidenceReason(roleEvidence(pastCfo, intent, now), "", []).includes("Matches requested reporting context: CFO"));
assert.equal(scoreCandidateAgainstRequirements(restaurant, req, 0).roleEvidence, undefined, "applicant scoring remains unchanged");
const genericIntent = { ...intent, reportingContext: null };
assert.equal(roleEvidence(exact, genericIntent, now)?.matchedReportingContext, undefined);
console.log("Reporting context priority, dated careers, model fallback and legacy scoring passed.");
