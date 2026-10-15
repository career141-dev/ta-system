import assert from "node:assert/strict";
import { scoreLookalikeCandidate, searchLookalikes } from "../src/lib/lookalikeMatch";
import type { Candidate } from "../src/data/types";
import type { ReferenceCvBlueprint } from "../src/lib/referenceCv";

const blueprint: ReferenceCvBlueprint = {
  targetTitle: "Senior DevOps Engineer",
  alternativeTitles: ["Cloud Engineer", "Site Reliability Engineer"],
  seniority: "senior",
  totalExperienceYears: 6,
  minYears: 4,
  maxYears: 8,
  skills: ["Kubernetes", "AWS", "Terraform", "Docker", "CI/CD", "Linux"],
  employers: ["Virtusa", "Sysco Labs"],
  industries: ["Information Technology", "Cloud Services"],
  education: ["B.Sc Computer Science"],
  summary: "Senior DevOps engineer with 6 years experience in AWS, Kubernetes and Terraform.",
  suggestedQuery: "Senior DevOps Engineer Kubernetes AWS Terraform",
};

const strongCandidate: Candidate = {
  id: "c-strong" as any,
  fullName: "Alice Perera",
  email: "alice@example.invalid",
  phone: "0771234567",
  linkedinUrl: null,
  location: "Colombo",
  nationality: "Sri Lankan",
  age: 30,
  gender: "female",
  currentEmployer: "Virtusa",
  currentTitle: "Senior DevOps Engineer",
  totalExperienceYears: 6,
  educationDegree: "B.Sc Computer Science",
  educationInstitution: null,
  qualifications: null,
  englishLevel: 8,
  languages: ["English"],
  skills: ["Kubernetes", "AWS", "Terraform", "Docker", "CI/CD", "Python"],
  industries: ["Information Technology"],
  noticePeriodDays: 30,
  currentSalary: null,
  expectedSalary: null,
  cvFileName: "alice.pdf",
  workHistory: [
    { title: "Senior DevOps Engineer", employer: "Virtusa", fromYear: 2021, toYear: null },
    { title: "DevOps Engineer", employer: "Sysco Labs", fromYear: 2018, toYear: 2021 },
  ],
  createdAt: Date.now(),
};

const weakCandidate: Candidate = {
  id: "c-weak" as any,
  fullName: "Bob Silva",
  email: "bob@example.invalid",
  phone: "0779876543",
  linkedinUrl: null,
  location: "Kandy",
  nationality: "Sri Lankan",
  age: 23,
  gender: "male",
  currentEmployer: "Small Shop",
  currentTitle: "Junior QA Tester",
  totalExperienceYears: 1,
  educationDegree: null,
  educationInstitution: null,
  qualifications: null,
  englishLevel: 6,
  languages: ["English"],
  skills: ["Manual Testing", "Jira"],
  industries: ["Retail"],
  noticePeriodDays: 14,
  currentSalary: null,
  expectedSalary: null,
  cvFileName: "bob.pdf",
  workHistory: [{ title: "Junior QA Tester", employer: "Small Shop", fromYear: 2023, toYear: null }],
  createdAt: Date.now(),
};

// Test scoring
const strongMatch = scoreLookalikeCandidate(strongCandidate, blueprint);
const weakMatch = scoreLookalikeCandidate(weakCandidate, blueprint);

assert.ok(strongMatch.score >= 80, `Strong candidate must score >= 80 (got ${strongMatch.score})`);
assert.ok(weakMatch.score < 50, `Weak candidate must score < 50 (got ${weakMatch.score})`);
assert.ok(strongMatch.score > weakMatch.score, "Strong candidate must score significantly higher than weak candidate");

assert.equal(strongMatch.experienceDeltaYears, 0, "Experience delta should be 0");
assert.ok(strongMatch.sharedSkills.length >= 4, "Strong candidate should share >= 4 skills");
assert.ok(strongMatch.matchedEmployers.includes("Virtusa"), "Should identify Virtusa as matched employer");

// Test recruiter guidance prompt impact
const promptCandidate: Candidate = {
  ...strongCandidate,
  id: "c-fintech" as any,
  fullName: "Carol Fernando",
  industries: ["Fintech", "Banking"],
  workHistory: [{ title: "Senior DevOps Engineer", employer: "Commercial Bank", fromYear: 2020, toYear: null }],
};

const matchWithoutPrompt = scoreLookalikeCandidate(promptCandidate, blueprint, "");
const matchWithPrompt = scoreLookalikeCandidate(promptCandidate, blueprint, "Must have banking fintech background");

assert.ok(
  matchWithPrompt.score >= matchWithoutPrompt.score,
  "Candidate with matching prompt criteria should score higher"
);

console.log("lookalikeMatch tests passed successfully!");
