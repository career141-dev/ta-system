/**
 * The current system's records, in this platform's shape. Pure functions, so
 * what gets copied is visible and tested.
 */
import type { Candidate } from "@/data/types";
import { externalUrl } from "@/lib/url";

export interface LiveResume {
  _id: string;
  candidateId: string;
  rawText?: string;
  rawTextKey?: string;
  jobHistory?: { company?: string; title?: string; startDate?: string; endDate?: string }[];
  embedding?: number[];
  hasEmbedding?: boolean;
}

export type LiveCandidate = Record<string, any> & { _id: string; _creationTime?: number };

/** A four-digit year from "Jan 2019", "2019-03", "03/2019" or "Present". */
export function yearOf(text: string | undefined, now = new Date().getFullYear()): number | null {
  if (!text) return null;
  if (/present|current|now|to date|till date/i.test(text)) return null;
  const y = text.match(/(19[6-9]\d|20\d\d)/)?.[1];
  return y && Number(y) <= now + 1 ? Number(y) : null;
}

const money = (amount: unknown, currency: unknown) =>
  typeof amount === "number" && amount > 0 ? `${currency ? `${currency} ` : ""}${amount.toLocaleString("en-US")}` : null;

export const liveId = (convexId: string) => `lv_${convexId}`;

export function mapCandidate(c: LiveCandidate, resume: LiveResume | null): Candidate {
  const history = (c.jobHistory?.length ? c.jobHistory : resume?.jobHistory ?? []) as LiveResume["jobHistory"];
  const edu = Array.isArray(c.education) && c.education.length ? c.education[0] : null;
  return {
    id: liveId(c._id),
    fullName: c.fullName || "Unnamed candidate",
    email: c.email ?? null,
    phone: c.phone ?? null,
    linkedinUrl: externalUrl(c.linkedinUrl),
    location: c.location ?? c.locationStructured?.raw_text ?? null,
    nationality: c.nationality ?? null,
    age: typeof c.age === "number" ? c.age : null,
    gender: c.gender ?? null,
    currentEmployer: c.currentEmployer ?? null,
    currentTitle: c.currentJobTitle || c.currentTitle || null,
    totalExperienceYears: typeof c.totalExperienceYears === "number" ? c.totalExperienceYears : typeof c.yearsOfExperience === "number" ? c.yearsOfExperience : null,
    educationDegree: c.educationDegree ?? edu?.degree ?? null,
    educationInstitution: c.educationInstitution ?? edu?.institution ?? null,
    qualifications: Array.isArray(c.certifications) && c.certifications.length ? c.certifications.join(", ") : null,
    englishLevel: null,
    languages: Array.isArray(c.languages) ? c.languages.map(String) : [],
    skills: Array.isArray(c.skills) ? c.skills.map((s: unknown) => (typeof s === "object" && s && "value" in (s as object) ? String((s as { value: unknown }).value) : String(s))) : [],
    industries: Array.isArray(c.industries) ? c.industries.map(String) : c.sector ? [String(c.sector)] : [],
    noticePeriodDays: typeof c.noticePeriodDays === "number" ? c.noticePeriodDays : null,
    currentSalary: money(c.currentSalary, c.currentSalaryCurrency),
    expectedSalary: money(c.expectedSalary, c.expectedSalaryCurrency),
    cvFileName: null,
    workHistory: (history ?? [])
      .filter((h) => h && h.title)
      .map((h) => ({ title: String(h.title), employer: String(h.company ?? ""), fromYear: yearOf(h.startDate) ?? 0, toYear: yearOf(h.endDate) })),
    createdAt: typeof c._creationTime === "number" ? Math.round(c._creationTime) : Date.now(),
  };
}

/** Where a CV's text is: in the database, only in R2 (not fetched), or nowhere. */
export function textSource(r: LiveResume | null): "db" | "r2" | "none" {
  if (r?.rawText && r.rawText.trim().length >= 30) return "db";
  if (r?.rawTextKey) return "r2";
  return "none";
}
