import type { ReferenceCvBlueprint } from "./referenceCv";

export const REFERENCE_PROFILE_PARAM = "ref";
export const MAX_REFERENCE_PROFILE_PARAM = 4_096;

export interface ReferenceSearchProfile {
  version: 1;
  role: string;
  alternativeTitles: string[];
  seniority: "junior" | "mid" | "senior" | "lead" | "executive";
  totalExperienceYears: number | null;
  minYears: number | null;
  maxYears: number | null;
  coreSkills: string[];
  supportingSkills: string[];
  industries: string[];
  education: string[];
  sourceCandidateId?: string;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;

function text(value: unknown, max = 100): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim().slice(0, max);
  return EMAIL.test(clean) || PHONE.test(clean) ? "" : clean;
}

function list(value: unknown, maxItems: number, maxLength = 80): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const clean = text(item, maxLength);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function years(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(60, Math.round(value * 2) / 2));
}

function seniority(value: unknown): ReferenceSearchProfile["seniority"] {
  return value === "junior" || value === "senior" || value === "lead" || value === "executive" ? value : "mid";
}

/**
 * The shareable search reference deliberately carries no name, contacts, raw
 * CV text, filename or employer. It is a job profile, not a copy of a person's
 * CV, and is bounded so a search URL cannot grow without limit (15 Oct 2026).
 */
export function referenceProfileFromBlueprint(
  blueprint: ReferenceCvBlueprint,
  sourceCandidateId?: string,
): ReferenceSearchProfile {
  const allSkills = list(blueprint.skills, 14);
  const requestedCore = list(blueprint.coreSkills, 6);
  const coreSkills = requestedCore.length ? requestedCore : allSkills.slice(0, 6);
  const core = new Set(coreSkills.map((skill) => skill.toLowerCase()));
  const requestedSupporting = list(blueprint.supportingSkills, 8);
  const supportingSkills = [...requestedSupporting, ...allSkills]
    .filter((skill, index, values) => !core.has(skill.toLowerCase()) && values.findIndex((v) => v.toLowerCase() === skill.toLowerCase()) === index)
    .slice(0, 8);
  const candidateId = text(sourceCandidateId, 100);

  return {
    version: 1,
    role: text(blueprint.targetTitle, 120) || "Specialist",
    alternativeTitles: list(blueprint.alternativeTitles, 5, 100),
    seniority: seniority(blueprint.seniority),
    totalExperienceYears: years(blueprint.totalExperienceYears),
    minYears: years(blueprint.minYears),
    maxYears: years(blueprint.maxYears),
    coreSkills,
    supportingSkills,
    industries: list(blueprint.industries, 4),
    education: list(blueprint.education, 3, 120),
    ...(candidateId ? { sourceCandidateId: candidateId } : {}),
  };
}

export function validateReferenceProfile(value: unknown): ReferenceSearchProfile | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReferenceSearchProfile>;
  const role = text(input.role, 120);
  if (input.version !== 1 || !role) return null;
  const sourceCandidateId = text(input.sourceCandidateId, 100);
  return {
    version: 1,
    role,
    alternativeTitles: list(input.alternativeTitles, 5, 100),
    seniority: seniority(input.seniority),
    totalExperienceYears: years(input.totalExperienceYears),
    minYears: years(input.minYears),
    maxYears: years(input.maxYears),
    coreSkills: list(input.coreSkills, 6),
    supportingSkills: list(input.supportingSkills, 8),
    industries: list(input.industries, 4),
    education: list(input.education, 3, 120),
    ...(sourceCandidateId ? { sourceCandidateId } : {}),
  };
}

export function serializeReferenceProfile(profile: ReferenceSearchProfile): string {
  const valid = validateReferenceProfile(profile);
  if (!valid) throw new Error("Invalid reference profile.");
  const encoded = Buffer.from(JSON.stringify(valid), "utf8").toString("base64url");
  if (encoded.length > MAX_REFERENCE_PROFILE_PARAM) throw new Error("The reference profile is too large.");
  return encoded;
}

export function parseReferenceProfile(value: unknown): ReferenceSearchProfile | null {
  if (typeof value !== "string" || !value || value.length > MAX_REFERENCE_PROFILE_PARAM) return null;
  try {
    return validateReferenceProfile(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function referenceProfileSearchText(profile: ReferenceSearchProfile): string {
  return [
    profile.role,
    ...profile.alternativeTitles.slice(0, 3),
    ...profile.coreSkills,
    ...profile.supportingSkills.slice(0, 3),
    ...profile.industries.slice(0, 2),
  ].filter(Boolean).join(" ");
}
