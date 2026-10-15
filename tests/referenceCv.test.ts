import assert from "node:assert/strict";
import { extractBlueprintFromText } from "../src/lib/referenceCv";

const sampleCvText = `
Jane Doe
Senior Full-Stack Engineer
Colombo, Sri Lanka

Professional Summary:
Passionate Senior Full-Stack Engineer with 7 years of experience in building scalable cloud web applications using React, Node.js, TypeScript, and AWS.

Work History:
Senior Software Engineer at Virtusa (2021 - Present)
- Architected enterprise cloud microservices using Node.js, TypeScript, PostgreSQL, and Docker.
- Implemented CI/CD pipelines on AWS using Terraform and GitHub Actions.

Software Engineer at Sysco Labs (2018 - 2021)
- Developed front-end responsive portals using React, Redux, and modern CSS.

Core Skills:
React, TypeScript, Node.js, AWS, Docker, Kubernetes, PostgreSQL, Git, CI/CD, Agile

Education:
B.Sc. in Computer Science - University of Colombo
`;

const blueprint = await extractBlueprintFromText(sampleCvText);

assert.ok(blueprint.targetTitle, "Must extract a target title");
assert.ok(blueprint.targetTitle.toLowerCase().includes("engineer"), "Title should contain engineer");
assert.equal(blueprint.seniority, "senior", "Seniority should be senior");
assert.equal(blueprint.totalExperienceYears, 7, "Total experience should match 7 years");
assert.ok(blueprint.skills.length >= 3, "Must extract multiple skills");
assert.ok(blueprint.skills.some((s) => /react|typescript|node|aws/i.test(s)), "Extracted skills should contain key stack");

console.log("referenceCv tests passed successfully!");
