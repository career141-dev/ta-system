/**
 * A decline is an answer.
 *
 * The transcript that produced this (23 September): the candidate said
 * "negotiable", then "open to discuss", and was asked for a figure both times
 * — the second reply almost word for word the first. The chase closed a
 * question only on a NUMBER, so words were treated as silence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCurrentSalary,
  hasExpectedSalary,
  hasNoticePeriod,
  noticePeriodToDays,
} from "../convex/lib/answered";

test("a figure answers the question", () => {
  assert.equal(hasCurrentSalary({ currentSalary: 12200 }), true);
  assert.equal(hasExpectedSalary({ expectedSalary: 300000 }), true);
  assert.equal(hasNoticePeriod({ noticePeriodDays: 30 }), true);
});

test("zero is an answer, not an absence", () => {
  // A student earns 0 and "immediate" is 0 notice. The old checks got this
  // right; the helpers must not regress it by leaning on truthiness.
  assert.equal(hasCurrentSalary({ currentSalary: 0 }), true, "a student earning nothing has answered");
  assert.equal(hasNoticePeriod({ noticePeriodDays: 0 }), true, "immediate is an answer");
});

test("words answer the question too", () => {
  assert.equal(hasExpectedSalary({ expectedSalaryNote: "negotiable" }), true);
  assert.equal(hasExpectedSalary({ expectedSalaryNote: "open to discuss" }), true);
  assert.equal(hasCurrentSalary({ currentSalaryNote: "I'd rather not say" }), true);
  assert.equal(hasNoticePeriod({ noticePeriod: "two months" }), true);
  assert.equal(hasNoticePeriod({ noticePeriod: "not sure yet" }), true);
});

test("nothing, or only whitespace, is still unanswered", () => {
  assert.equal(hasExpectedSalary({}), false);
  assert.equal(hasExpectedSalary(null), false);
  assert.equal(hasExpectedSalary({ expectedSalaryNote: "   " }), false);
  assert.equal(hasNoticePeriod({ noticePeriod: "" }), false);
});

test("words convert to days only when unambiguous", () => {
  assert.equal(noticePeriodToDays("30 days"), 30);
  assert.equal(noticePeriodToDays("2 months"), 60);
  assert.equal(noticePeriodToDays("two months"), null, "spelled-out numbers are not guessed");
  assert.equal(noticePeriodToDays("3 weeks"), 21);
  assert.equal(noticePeriodToDays("1 year"), 365);
  assert.equal(noticePeriodToDays("45"), 45);
});

test("immediate availability is zero days", () => {
  for (const text of ["immediate", "Immediately", "ASAP", "available now", "no notice"]) {
    assert.equal(noticePeriodToDays(text), 0, `${text} should be 0`);
  }
});

test("vague answers are left as words for a person to read", () => {
  for (const text of ["not sure yet", "depends on handover", "end of the quarter", "", null, undefined]) {
    assert.equal(noticePeriodToDays(text as string), null, `${String(text)} must not be guessed`);
  }
});
