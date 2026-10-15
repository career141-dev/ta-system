import assert from "node:assert/strict";
import { setupChecks, researchMissing, researchVersion, linkedinPostUrl, RESEARCH_FIELDS, type SetupEvidence } from "../src/lib/workdayRequirements";
import { completionBlockers, emailBlockers, confirmedResearchLink } from "../src/lib/workday";

const base: SetupEvidence = { jobId: "job", workType: "100%", userId: "ta", research: { version: "v1", missing: [...RESEARCH_FIELDS] },
  suggestions: { successful: false, pending: 0, count: 0, version: "r1" }, profiles: { count: 0 }, ready: 0, submitted: 0 };
const evaluate = (patch: Partial<SetupEvidence> = {}) => setupChecks({ ...base, ...patch });
const find = (key: string, patch: Partial<SetupEvidence> = {}) => setupChecks({ ...base, ...patch }, key === "suggestions").find(c => c.key.startsWith(key + ":"))!;
assert.equal(evaluate().length, 7);
assert.ok(!evaluate().some(c => c.key.startsWith("suggestions:")), "Suggestions is temporarily absent from workday requirements");
assert.ok(setupChecks(base, true).some(c => c.key.startsWith("suggestions:")), "Saved suggestion review rules remain available for later work");
assert.equal(find("jd_review").status, "incomplete");
assert.equal(find("jd_review", { jd: { version: "JD", approved: false, reviewedVersion: "JD" } }).status, "incomplete");
assert.equal(find("jd_review", { jd: { version: " ", approved: true, reviewedVersion: " " } }).status, "incomplete");
assert.equal(find("jd_review", { jd: { version: "JD", approved: true, reviewedVersion: "JD", at: 123, by: "ta" } }).completedAt, 123);
assert.equal(find("jd_review", { jd: { version: "Changed JD", approved: true, reviewedVersion: "JD" } }).status, "incomplete");
assert.equal(find("excel_profiles").status, "incomplete");
assert.equal(find("excel_profiles", { profiles: { count: 1, at: 123 } }).completedAt, 123);
assert.equal(find("excel_profiles", { profiles: { count: 1 } }).status, "complete");
assert.equal(find("excel_profiles", { profiles: { count: 1 } }).progress, "1/1");
assert.equal(find("director_candidate", { noCandidateReason: "No suitable candidates", noCandidateAt: 42 }).status, "complete");
assert.equal(find("director_candidate", { ready: 1 }).status, "complete");
assert.equal(find("director_candidate", { submitted: 1 }).status, "complete");
assert.equal(find("research", { research: { version: "v1", reviewedVersion: "v1", missing: [] } }).status, "complete");
assert.equal(find("research", { research: { version: "v2", reviewedVersion: "v1", missing: [] } }).status, "incomplete");
assert.equal(find("suggestions", { suggestions: { successful: false, pending: 0, count: 0, version: "r1", emptyReason: "No profiles" } }).status, "incomplete");
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 0, count: 0, version: "r1", emptyReason: "No profiles" } }).status, "complete");
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 1, count: 2, version: "r1" } }).status, "incomplete");
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 0, count: 2, version: "r1" } }).status, "complete");
assert.equal(find("suggestions").needsEmptySuggestionsReason, false, "Never-run or failed searches do not ask for an explanation");
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 0, count: 0, version: "r1" } }).needsEmptySuggestionsReason, true);
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 0, count: 0, version: "r1", emptyReason: "No profiles" } }).needsEmptySuggestionsReason, false);
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 1, count: 2, version: "r1" } }).needsEmptySuggestionsReason, false, "Unreviewed results require review, not an empty-search explanation");
assert.equal(find("suggestions", { suggestions: { successful: true, pending: 0, count: 2, version: "r1" } }).needsEmptySuggestionsReason, false, "Reviewing all results does not turn the search into an empty one");
assert.equal(find("chatgpt", { chatgptLink: "https://chatgpt.com/share/12345678" }).status, "incomplete");
assert.equal(find("chatgpt", { chatgptLink: "https://chatgpt.com/c/12345678", confirmedAt: 1 }).status, "incomplete");
assert.equal(find("chatgpt", { chatgptLink: "https://chatgpt.com/share/12345678", confirmedAt: 123 }).completedAt, 123);
assert.equal(find("daily_email", { emailAt: 42 }).completedAt, 42);
assert.deepEqual(evaluate({ workType: "Follow-up" }), []);
assert.deepEqual(evaluate({ workType: "Add-on" }), []);
assert.equal(researchMissing({}, {}).length, 8);
assert.equal(researchMissing({}, Object.fromEntries(RESEARCH_FIELDS.map(k => [k, "Cannot source"]))).length, 0);
assert.equal(researchMissing({ servicesProvider: [" "] }, {}).length, 8);
assert.notEqual(researchVersion({ generatedAt: 1, fields: { country: "Sri Lanka" } }), researchVersion({ generatedAt: 1, fields: { country: "UK" } }));
assert.equal(linkedinPostUrl("https://www.linkedin.com/jobs/view/123"), true);
assert.equal(linkedinPostUrl("https://linkedin.com.evil.test/jobs/view/123"), false);
assert.equal(linkedinPostUrl("https://linkedin.com/in/person"), false);
const jobs = [{ checks: evaluate() }] as any;
assert.equal(completionBlockers(jobs).length, 7);
assert.equal(emailBlockers(jobs).length, 4);
assert.equal(confirmedResearchLink([{ ...find("chatgpt", { chatgptLink: "https://chatgpt.com/share/12345678", confirmedAt: 123 }) }]), "https://chatgpt.com/share/12345678", "The composer can reuse a saved, completed share-link check");
assert.equal(confirmedResearchLink([find("chatgpt", { chatgptLink: "https://chatgpt.com/share/12345678" })]), null, "An unconfirmed saved link must not be reused as confirmed");
assert.equal(confirmedResearchLink([{ ...find("chatgpt"), status: "complete", evidence: "https://chatgpt.com/c/private123" }]), null);
assert.deepEqual(emailBlockers(jobs).map(c => c.key.split(":")[0]), ["jd_review", "research", "excel_profiles", "chatgpt"]);
assert.equal(emailBlockers([{ checks: [{ key: "details:candidate", status: "incomplete", blocksEmail: true }] }] as any).length, 0, "Candidate queues do not block the temporary EOD setup gate");
assert.equal(emailBlockers([{ checks: [{ key: "mail:receipt", status: "incomplete" }] }] as any).length, 1, "Uncertain mail still blocks another send");
assert.equal(completionBlockers([{ checks: [{ ...find("excel_profiles"), status: "complete" }] }] as any).length, 0);
const mixed = [
  { workType: "100%", checks: evaluate() },
  { workType: "Follow-up", checks: evaluate(), eodChecks: evaluate() },
  { workType: "Add-on", checks: evaluate(), eodChecks: evaluate() },
] as any;
assert.equal(completionBlockers(mixed).length, 7, "Only the 100% position blocks finishing, even with stale returning tasks");
assert.equal(emailBlockers(mixed).length, 4, "Only the 100% position blocks sending");
console.log("Workday setup evidence, thresholds, exceptions, invalidation and email gates passed.");
