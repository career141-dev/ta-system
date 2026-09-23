/**
 * "Everything is in" must mean a CV actually exists.
 *
 * `checkAndAdvanceFollowUp` counted `candidate.isParsed === true` as having a
 * CV. `isParsed` only means the candidate RECORD was processed — a headhunted
 * profile gets it with no CV file anywhere. So headhunted candidates were
 * credited with a CV they had never sent, the checklist read "Everything is
 * in", and they were auto-advanced to Second Shortlist and offered to Director
 * Review without one (23 September, on the first real conversation).
 *
 * This reads the source: the bug was one `||` inside a boolean, which no type
 * check catches and which is cheap to reintroduce.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const helper = readFileSync(new URL("../convex/pipeline/followUpHelper.ts", import.meta.url), "utf8");

/**
 * Each `const hasCV = … ;` expression, whole.
 *
 * Read to the semicolon rather than line by line: one of the three spans
 * several lines, and a line-based match silently saw only `const hasCV =`
 * and passed a test that was checking nothing.
 */
function hasCvExpressions(source: string): string[] {
  const out: string[] = [];
  const re = /const hasCV\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const end = source.indexOf(";", m.index);
    if (end === -1) continue;
    out.push(source.slice(m.index, end + 1).replace(/\s+/g, " "));
  }
  return out;
}

test("a parsed candidate record is not a CV", () => {
  const found = hasCvExpressions(helper);
  assert.ok(found.length >= 3, `expected every hasCV check, found ${found.length}`);
  for (const expr of found) {
    assert.doesNotMatch(
      expr,
      /isParsed/,
      "isParsed means the record was processed, not that a CV exists — a headhunted " +
        "candidate would reach Director Review without one",
    );
  }
});

test("a CV is a file on the candidate or the application", () => {
  for (const expr of hasCvExpressions(helper)) {
    assert.match(expr, /cvUploadId/, `a CV must come from an actual upload: ${expr}`);
    assert.match(expr, /cvFileId/, `or from the file on the application: ${expr}`);
  }
});

test("both completeness checks use the shared answered rules", () => {
  // updateFollowUpFlags and checkAndAdvanceFollowUp disagreed: one accepted
  // "negotiable", the other demanded a number, so a candidate could be counted
  // complete on one path and chased on the other.
  for (const fn of ["hasCurrentSalary", "hasExpectedSalary", "hasNoticePeriod"]) {
    const uses = helper.split(fn).length - 1;
    assert.ok(uses >= 2, `${fn} should be used by both completeness checks, found ${uses}`);
  }
});
