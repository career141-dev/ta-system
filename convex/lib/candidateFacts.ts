import { ageOn } from "./candidateAge";
import { experienceCheck, experienceOn, statedExperience, type JobDates } from "./experience";

/**
 * A candidate's age and experience as of today, with where each came from and
 * anything a TA should question — worked out whenever a record is read
 * (ta/candidates, ta/search), not stored, so neither goes stale (28 Sep).
 *
 * Age: from the birth date read off the CV (lib/candidateAge); a hand-entered
 * age only when there is none. Experience: from the job dates
 * (lib/experience), checked against what the CV claims; the stored figure
 * only when the dates give none.
 */
export interface LiveFacts {
  age: number | null;
  /** dob · nic · stated_age · entered, or null when there is no age. */
  ageSource: string | null;
  ageNote: string | null;
  totalExperienceYears: number | null;
  /** job_dates when summed from the career, cv when only the stored figure exists. */
  experienceSource: "job_dates" | "cv" | null;
  experienceNote: string | null;
}

export function liveFacts(
  c: {
    dateOfBirth?: string;
    dateOfBirthSource?: string;
    dateOfBirthNote?: string;
    age?: number;
    totalExperienceYears?: number;
    yearsOfExperience?: number;
    summary?: string;
  },
  career: JobDates[] | null | undefined,
  asOf: Date = new Date(),
): LiveFacts {
  const birthYear = c.dateOfBirth ? Number(c.dateOfBirth.slice(0, 4)) : undefined;
  const exp = experienceOn(career, asOf, birthYear);
  const stored = c.totalExperienceYears ?? c.yearsOfExperience ?? null;
  const age = c.dateOfBirth ? ageOn(c.dateOfBirth, asOf) : typeof c.age === "number" ? c.age : null;
  return {
    age,
    ageSource: c.dateOfBirth ? c.dateOfBirthSource ?? "dob" : age !== null ? "entered" : null,
    ageNote: c.dateOfBirthNote ?? (c.dateOfBirthSource === "stated_age" ? "From the age written on the CV — could be a year out" : null),
    totalExperienceYears: exp?.years ?? stored,
    experienceSource: exp ? "job_dates" : stored !== null ? "cv" : null,
    experienceNote:
      experienceCheck(exp, statedExperience(c.summary)) ??
      (exp?.approximate ? "Some job dates are years only — could be a year out" : null),
  };
}
