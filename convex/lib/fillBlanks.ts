// convex/lib/fillBlanks.ts
//
// A replaced CV only fills gaps (29 Sep). The TA's "Replace CV" swaps the file;
// what the desk already holds — salaries, notice, experience, skills, contact
// details — stays, because the new CV may simply not mention it. Replacing
// used to run the new file through extraction as a brand-new CV, which wrote
// every field it read over the candidate and could clear lists to [].
//
// Pure, so it is tested without a database.

/** A stored value that already says something. `0` and `false` count. */
export function isFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * The part of `patch` that may be written onto `current`: keys whose current
 * value is empty, plus the `always` keys (the file itself and its text), which
 * describe the CV rather than the person. An empty patch value is never
 * written either — it could only clear.
 */
export function fillBlanksOnly(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
  always: readonly string[] = [],
  groups: readonly (readonly string[])[] = SAME_FACT,
): Record<string, unknown> {
  // One fact kept in several fields: if any of them is filled, none is written.
  const held = (k: string) => {
    const group = groups.find((g) => g.includes(k)) ?? [k];
    return group.some((g) => isFilled(current?.[g]));
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (always.includes(k)) {
      if (v !== undefined) out[k] = v;
      continue;
    }
    if (!isFilled(v)) continue;
    if (held(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Fields that say the same thing. A salary the TA typed in words lives in
 * `taExpectedSalaryText`; a CV's number must not appear beside it as a
 * second, different answer. Likewise notice as days or as words.
 */
export const SAME_FACT: readonly (readonly string[])[] = [
  ["expectedSalary", "expectedSalaryCurrency", "taExpectedSalaryText", "expectedSalaryNote"],
  ["currentSalary", "currentSalaryCurrency", "taCurrentSalaryText", "currentSalaryNote"],
  ["noticePeriod", "noticePeriodDays", "availability"],
  ["currentTitle", "currentJobTitle"],
  ["phone", "phoneClean"],
  ["dateOfBirth", "dateOfBirthSource", "dateOfBirthNote"],
  ["gender", "genderSource"],
  ["location", "locationStructured"],
  ["educationDegree", "educationInstitution", "educationYear"],
];

/** What a replaced CV always updates: the file, its text and its search vector. */
export const CV_FILE_KEYS = ["rawTextKey", "fileHash", "cvUploadId", "isParsed", "hasEmbedding", "extractionModel"] as const;
