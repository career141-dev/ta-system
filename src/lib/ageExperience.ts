import type { Candidate } from "@/data/types";

/**
 * How a candidate's age and experience read on screen — one wording for the
 * profile, the drawer and the list rows (28 Sep). Both are worked out as of
 * today by the backend (convex/lib/candidateFacts); this only says them, and
 * says where each came from, so a TA knows how far to trust it.
 */
const AGE_SOURCE: Record<string, string> = {
  dob: "from the date of birth on the CV",
  nic: "from their NIC number",
  stated_age: "from the age written on the CV",
  entered: "entered by hand",
};

export function ageText(c: Pick<Candidate, "age">): string | null {
  return c.age != null ? `${c.age} years` : null;
}

/** "from their NIC number" — plus any doubt, e.g. the CV's date and NIC disagree. */
export function ageHint(c: Pick<Candidate, "ageSource" | "ageNote">): string | null {
  const from = c.ageSource ? AGE_SOURCE[c.ageSource] ?? null : null;
  return [from, c.ageNote].filter(Boolean).join(" · ") || null;
}

export function experienceText(c: Pick<Candidate, "totalExperienceYears">): string | null {
  return c.totalExperienceYears != null ? `${c.totalExperienceYears} years` : null;
}
