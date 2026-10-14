import assert from "node:assert/strict";
import { repo } from "../src/data/store";
import { extractBlueprintFromText } from "../src/lib/referenceCv";
import { searchLookalikes, scoreLookalikeCandidate } from "../src/lib/lookalikeMatch";

const candidates = repo.candidates();
assert.ok(candidates.length > 0, "Store must contain candidates");

// Pick a reference candidate
const referenceCandidate = candidates[0];

// Extract blueprint from simulated CV text
const simulatedCv = `
${referenceCandidate.fullName}
${referenceCandidate.currentTitle || "Senior Software Engineer"}
Colombo, Sri Lanka

Professional Summary:
Proven professional with ${(referenceCandidate.totalExperienceYears || 5)} years of experience in ${(referenceCandidate.skills || ["Software Development"]).slice(0, 4).join(", ")}.

Work History:
${referenceCandidate.currentTitle || "Software Engineer"} at ${referenceCandidate.currentEmployer || "Tech Corp"} (2021 - Present)
${(referenceCandidate.workHistory || []).map((h) => `${h.title} at ${h.employer} (${h.fromYear} - ${h.toYear || "Present"})`).join("\n")}

Skills:
${(referenceCandidate.skills || ["JavaScript", "React", "Node.js"]).join(", ")}
`;

const blueprint = await extractBlueprintFromText(simulatedCv);
assert.ok(blueprint.targetTitle, "Blueprint must have target title");
assert.ok(blueprint.skills.length > 0, "Blueprint must have skills");

// Perform search
const results = await searchLookalikes(blueprint, "Must have solid background", 20);

assert.ok(results.totalHits > 0, "Search must return matching candidates");
assert.ok(results.matches.length > 0, "Matches list must not be empty");

// Validate candidate ordering
for (let i = 0; i < results.matches.length - 1; i++) {
  assert.ok(
    results.matches[i].score >= results.matches[i + 1].score,
    `Matches should be ordered descending by score: ${results.matches[i].score} vs ${results.matches[i + 1].score}`
  );
}

// Validate candidate match metrics
const topMatch = results.matches[0];
assert.ok(topMatch.score >= 50, "Top match score should be reasonable");
assert.ok(topMatch.rating, "Top match must have rating");
assert.ok(topMatch.matchSummary, "Top match must have human-readable summary");

console.log("lookalikeEndToEnd tests passed successfully!");
