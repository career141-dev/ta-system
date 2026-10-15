import assert from "node:assert/strict";
import {
  MAX_REFERENCE_PROFILE_PARAM,
  parseReferenceProfile,
  referenceProfileFromBlueprint,
  serializeReferenceProfile,
  validateReferenceProfile,
} from "../src/lib/referenceSearchProfile";

const profile = referenceProfileFromBlueprint({
  targetTitle: "Senior Full-Stack Engineer",
  alternativeTitles: ["Software Engineer", "Full-Stack Developer"],
  seniority: "senior",
  totalExperienceYears: 7,
  minYears: 5,
  maxYears: 10,
  skills: ["React", "TypeScript", "Node.js", "AWS", "Docker", "Python"],
  coreSkills: ["React", "TypeScript", "Node.js", "candidate@example.com"],
  supportingSkills: ["AWS", "Docker", "Python"],
  employers: ["A former employer must not travel with the search"],
  industries: ["Technology"],
  education: ["BSc Computer Science"],
  summary: "A person's raw summary must not travel with the search.",
  suggestedQuery: "",
}, "candidate-123");

assert.deepEqual(profile.coreSkills, ["React", "TypeScript", "Node.js"], "contact data is removed from skills");
assert.equal("employers" in profile, false, "reference employers never become search constraints");
assert.equal("summary" in profile, false, "raw or identifying summaries are not serialized");
const encoded = serializeReferenceProfile(profile);
assert.ok(encoded.length <= MAX_REFERENCE_PROFILE_PARAM, "the URL payload is bounded");
assert.deepEqual(parseReferenceProfile(encoded), profile, "a valid profile survives a shared search URL");
assert.equal(parseReferenceProfile("not-json"), null, "malformed URL data is rejected");
assert.equal(validateReferenceProfile({ version: 1, role: "person@example.com" }), null, "a role containing contact data is rejected");

console.log("Reference search profile sanitization and serialization tests passed.");
