/**
 * One candidate's full record, in the shape the profile page reads.
 *
 * Pure, so what is shown — and what is left out — is visible and tested. The
 * list screens keep using the narrow `Candidate` from the shared mapper; this
 * is only what a profile adds on top of it.
 */

export interface ProfileCareer {
  title: string;
  employer: string | null;
  from: string | null;
  to: string | null;
  current: boolean;
  description: string | null;
}

export interface ProfileEducation {
  degree: string | null;
  field: string | null;
  institution: string | null;
  year: string | null;
}

export interface ProfileReferee {
  name: string;
  designation: string | null;
  company: string | null;
  contactNo: string | null;
  email: string | null;
  relationship: string | null;
}

export interface ProfileMatch {
  applicationId: string;
  jobId: string;
  jobTitle: string | null;
  clientName: string | null;
  score: number | null;
  explanation: string | null;
}

export interface ProfileCv {
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  status: string | null;
  storage: "r2" | "convex" | "none";
}

export interface CandidateProfile {
  summary: string | null;
  seniority: string | null;
  roleFamily: string | null;
  sector: string | null;
  source: string | null;
  availability: string | null;
  employmentStatus: string | null;
  noticePeriodText: string | null;
  age: number | null;
  gender: string | null;
  languages: string[];
  certifications: string[];
  pastTitles: string[];
  career: ProfileCareer[];
  education: ProfileEducation[];
  referees: ProfileReferee[];
  matches: ProfileMatch[];
  doNotContact: { reason: string | null; at: number | null } | null;
  firstSeenAt: number | null;
  lastUpdatedAt: number | null;
  cv: ProfileCv | null;
  cvText: string | null;
  cvTextInR2: boolean;
}

/** What `ta/candidates:profile` returns. */
export interface RawProfile {
  candidate: Record<string, unknown>;
  referees: ProfileReferee[];
  matches: ProfileMatch[];
  cv: ProfileCv | null;
  cvText: string | null;
  cvTextInR2: boolean;
}

const str = (v: unknown): string | null => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(str).filter((x): x is string => !!x))] : [];
const isCurrent = (end: string | null) => !end || /present|current|now|to date|till date/i.test(end);

export function mapProfile(raw: RawProfile): CandidateProfile {
  const c = raw.candidate;

  const history = (Array.isArray(c.jobHistory) ? c.jobHistory : []) as Record<string, unknown>[];
  const career: ProfileCareer[] = history
    .map((h) => {
      const to = str(h?.endDate);
      const from = str(h?.startDate);
      return {
        title: str(h?.title) ?? "",
        employer: str(h?.company),
        from,
        to: isCurrent(to) ? null : to,
        current: isCurrent(to) && !!from,
        description: str(h?.description),
      };
    })
    .filter((h) => h.title || h.employer);

  const schooling = (Array.isArray(c.education) ? c.education : []) as Record<string, unknown>[];
  const education: ProfileEducation[] = schooling
    .map((e) => ({
      degree: str(e?.degree),
      field: str(e?.field),
      institution: str(e?.institution),
      year: str(e?.year),
    }))
    .filter((e) => e.degree || e.institution);
  // The flat fields are an older extraction's answer. Kept only when the list
  // does not already say the same thing, so a degree is not printed twice.
  const flatDegree = str(c.educationDegree);
  const flatInstitution = str(c.educationInstitution);
  if (
    (flatDegree || flatInstitution) &&
    !education.some((e) => e.degree === flatDegree && e.institution === flatInstitution)
  ) {
    education.push({ degree: flatDegree, field: null, institution: flatInstitution, year: str(c.educationYear) });
  }

  return {
    summary: str(c.summary),
    seniority: str(c.seniorityLevel),
    roleFamily: str(c.roleFamily),
    sector: str(c.sector),
    source: str(c.firstSourceChannel) ?? str(c.sourceChannel),
    availability: str(c.availability),
    employmentStatus: str(c.employmentStatus),
    noticePeriodText: str(c.noticePeriod),
    age: typeof c.age === "number" ? c.age : null,
    gender: str(c.gender),
    languages: strings(c.languages),
    certifications: strings(c.certifications),
    pastTitles: strings(c.pastJobTitles),
    career,
    education,
    referees: raw.referees ?? [],
    // Best first; an application the engine never scored goes last, not first.
    matches: [...(raw.matches ?? [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    doNotContact:
      c.doNotContact === true
        ? { reason: str(c.doNotContactReason), at: typeof c.doNotContactAt === "number" ? c.doNotContactAt : null }
        : null,
    firstSeenAt: typeof c.firstSeenAt === "number" ? c.firstSeenAt : null,
    lastUpdatedAt: typeof c.lastUpdatedAt === "number" ? c.lastUpdatedAt : null,
    cv: raw.cv,
    cvText: raw.cvText,
    cvTextInR2: raw.cvTextInR2,
  };
}

/** "68 KB", "2.4 MB". */
export function fileSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Only PDFs render inline in a browser; Word files are offered as a download. */
export const previewsInline = (cv: ProfileCv | null) =>
  !!cv && (/pdf/i.test(cv.fileType ?? "") || /\.pdf$/i.test(cv.fileName ?? ""));
