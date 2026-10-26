import assert from "node:assert/strict";
import test from "node:test";
import { cvExtractionSchema } from "../convex/cvs/cvExtraction";

test("one entry given as a bare object is read as a list of one", () => {
  const r = cvExtractionSchema.parse({ fullName: "A", education: { degree: "BSc", institution: "Colombo" } });
  assert.deepEqual(r.education?.map((e) => e.degree), ["BSc"]);
});

test("nulls and lines of text in a list are dropped, the entries kept", () => {
  const r = cvExtractionSchema.parse({
    fullName: "A",
    jobHistory: [null, "Worked at X", { company: "Y", title: "Engineer", confidence: "0.9" }],
    referees: "Available on request",
  });
  assert.deepEqual(r.jobHistory?.map((j) => j.company), ["Y"]);
  assert.equal(r.jobHistory?.[0].confidence, 0.9);
  assert.deepEqual(r.referees, []);
});

test("an ordinary answer is unchanged", () => {
  const r = cvExtractionSchema.parse({ fullName: "A", education: [{ degree: "MSc", year: "2020" }], jobHistory: null });
  assert.equal(r.education?.[0].year, 2020);
  assert.equal(r.jobHistory, null);
});
