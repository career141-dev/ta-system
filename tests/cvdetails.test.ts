import assert from "node:assert/strict";
import test from "node:test";
import { cvExtractionSchema } from "../convex/cvs/cvExtraction";
import { cvDetailsPatch } from "../convex/lib/fillBlanks";

test("the CV reader accepts current salary, expected salary and notice", () => {
  const r = cvExtractionSchema.parse({
    fullName: "A",
    currentSalary: "150,000",
    currentSalaryCurrency: "LKR",
    expectedSalary: 200000,
    noticePeriod: "1 month",
  });
  assert.equal(r.currentSalary, 150000);
  assert.equal(r.currentSalaryCurrency, "LKR");
  assert.equal(r.expectedSalary, 200000);
  assert.equal(r.noticePeriod, "1 month");
});

test("a blank or worded salary is no figure, never 0", () => {
  const r = cvExtractionSchema.parse({ fullName: "A", currentSalary: "", expectedSalary: "negotiable" });
  assert.equal(r.currentSalary, null);
  assert.equal(r.expectedSalary, null);
});

test("empty record: the CV's figures are written and remembered", () => {
  const { patch, held } = cvDetailsPatch({}, { currentSalary: 100, noticePeriod: "Immediate", noticePeriodDays: 0 }, undefined);
  assert.equal(patch.currentSalary, 100);
  assert.equal(patch.noticePeriodDays, 0);
  assert.deepEqual(held, { currentSalary: 100, noticePeriod: "Immediate", noticePeriodDays: 0 });
});

test("a newer CV replaces what an earlier CV wrote, clearing its stale currency", () => {
  const current = { currentSalary: 100, currentSalaryCurrency: "LKR" };
  const { patch, held } = cvDetailsPatch(current, { currentSalary: 150 }, { currentSalary: 100, currentSalaryCurrency: "LKR" });
  assert.equal(patch.currentSalary, 150);
  assert.ok("currentSalaryCurrency" in patch && patch.currentSalaryCurrency === undefined);
  assert.deepEqual(held, { currentSalary: 150 });
});

test("a value a person changed is kept", () => {
  const { patch } = cvDetailsPatch({ currentSalary: 120 }, { currentSalary: 150 }, { currentSalary: 100 });
  assert.deepEqual(patch, {});
});

test("records from before the snapshot, and spoken answers, are a person's", () => {
  assert.deepEqual(cvDetailsPatch({ expectedSalary: 200 }, { expectedSalary: 300 }, undefined).patch, {});
  assert.deepEqual(cvDetailsPatch({ expectedSalaryNote: "negotiable" }, { expectedSalary: 300 }, undefined).patch, {});
  assert.deepEqual(cvDetailsPatch({ taCurrentSalaryText: "about 90k" }, { currentSalary: 300 }, undefined).patch, {});
  assert.deepEqual(cvDetailsPatch({ availability: "after exams" }, { noticePeriod: "1 month" }, undefined).patch, {});
});

test("a CV that states nothing changes nothing", () => {
  const { patch, held } = cvDetailsPatch({ currentSalary: 100 }, {}, { currentSalary: 100 });
  assert.deepEqual(patch, {});
  assert.deepEqual(held, { currentSalary: 100 });
});

test("each fact decides on its own", () => {
  const current = { currentSalary: 100, expectedSalary: 250 };
  const { patch } = cvDetailsPatch(current, { currentSalary: 120, expectedSalary: 300 }, { currentSalary: 100 });
  assert.equal(patch.currentSalary, 120);
  assert.ok(!("expectedSalary" in patch));
});
