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

/**
 * Salary and notice a CV states (29 Oct). They go stale, so a newer CV may
 * replace what an EARLIER CV wrote — but never what a person put there (the
 * candidate in follow-up, an AI call, the TA). `held` is the snapshot of what
 * the CV last wrote: a stored value that still equals it was never touched
 * since, anything else is a person's answer. Records from before this have no
 * snapshot, and the CV never wrote these then, so all their values are a
 * person's. A CV that states nothing changes nothing.
 */
export const CV_DETAIL_FACTS: readonly (readonly string[])[] = [
  ["currentSalary", "currentSalaryCurrency"],
  ["expectedSalary", "expectedSalaryCurrency"],
  ["noticePeriod", "noticePeriodDays"],
];

export function cvDetailsPatch(
  current: Record<string, unknown> | null | undefined,
  read: Record<string, unknown>,
  held: Record<string, unknown> | null | undefined,
): { patch: Record<string, unknown>; held: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  const nextHeld: Record<string, unknown> = { ...(held ?? {}) };
  for (const keys of CV_DETAIL_FACTS) {
    if (!keys.some((k) => isFilled(read[k]))) continue;
    const group = SAME_FACT.find((g) => g.includes(keys[0])) ?? keys;
    const touched = group.some((k) => isFilled(current?.[k]) && current?.[k] !== held?.[k]);
    if (touched) continue;
    // undefined clears: a currency or day count of the older CV must not sit
    // beside a figure the new CV gave without one.
    for (const k of keys) {
      patch[k] = isFilled(read[k]) ? read[k] : undefined;
      if (patch[k] === undefined) delete nextHeld[k];
      else nextHeld[k] = patch[k];
    }
  }
  return { patch, held: nextHeld };
}

/** What a replaced CV always updates: the file, its text and its search vector. */
export const CV_FILE_KEYS = ["rawTextKey", "fileHash", "cvUploadId", "isParsed", "hasEmbedding", "extractionModel"] as const;
