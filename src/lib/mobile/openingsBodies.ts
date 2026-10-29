import { z } from "zod";

import { CONSENT_TEXT } from "@/lib/intake";
import { OPENING_STATUSES, WORKING_STAGES } from "@/lib/openings/writes";

/** Request bodies for the mobile openings writes, checked before anything runs. */
export const setStatusBody = z.object({ status: z.enum(OPENING_STATUSES) }).strict();
export const setWorkingStageBody = z.object({ stage: z.enum(WORKING_STAGES as [string, ...string[]]) }).strict();
export const binOpeningsBody = z.object({ openingIds: z.array(z.string().trim().min(1).max(200)).min(1).max(200) }).strict();

/** Parse a JSON body against a schema, or the sentence to send back. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, problem: string): { ok: true; value: T } | { ok: false; message: string } {
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: problem };
}

const text = (max: number) => z.string().max(max);

export const openingDetailsBody = z
  .object({
    title: text(200),
    salaryMin: text(40),
    salaryMax: text(40),
    salaryCurrency: text(10),
    packageNotes: text(500),
    locations: text(1000),
    targetNationalities: text(500),
    headcount: text(10),
    priorityTier: text(4),
  })
  .strict();

export const openingTeamBody = z
  .object({
    members: z
      .array(z.object({ userId: z.string().trim().min(1).max(200), role: z.enum(["primary_recruiter", "supporting_recruiter", "director", "client_contact"]) }).strict())
      .max(50),
  })
  .strict();

export const emptyBody = z.object({}).strict();
export const accessRequestBody = z.object({ reason: text(1000) }).strict();
export const accessDecisionBody = z.object({ decision: z.enum(["approve", "reject"]), reason: text(1000) }).strict();

export const newOpeningBody = z
  .object({
    clientId: z.string().trim().max(200),
    title: text(200),
    country: text(100),
    hiringFor: text(100),
    targetGender: z.enum(["", "Female", "Male"]),
    // Checked again, with the web's words, by validateWorkLocations.
    workLocations: z.array(z.object({ id: text(80), name: text(200), vacancies: z.number() }).strict()).max(50),
    notes: text(20000),
    recording: z
      .object({ key: z.string().regex(/^convex:[A-Za-z0-9_-]{1,200}$/), durationMs: z.number().int().min(0).max(24 * 3600 * 1000), consentText: z.literal(CONSENT_TEXT) })
      .strict()
      .nullable(),
    autoFollowUp: z.boolean(),
    assignedTaIds: z.array(z.string().trim().min(1).max(200)).max(50),
  })
  .strict();

export const newClientBody = z
  .object({
    name: text(200),
    industry: text(100),
    contactName: text(200),
    contactTitle: text(200),
    contactEmail: text(320),
  })
  .strict();

export const jdWriteBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_notes"), notes: text(20_000) }).strict(),
  z.object({ action: z.literal("generate"), notes: text(20_000) }).strict(),
  z.object({ action: z.literal("approve"), markdown: text(100_000) }).strict(),
  z.object({ action: z.literal("amend"), markdown: text(100_000) }).strict(),
  z.object({ action: z.literal("revise"), request: text(2_000), currentMarkdown: text(100_000) }).strict(),
  z.object({ action: z.literal("restore"), messageId: z.string().min(1).max(100) }).strict(),
  z.object({
    action: z.literal("save_details"),
    details: z.object({
      title: text(200), clientIndustry: text(100), recruitmentType: z.enum(["both", "headhunting", "job_posting"]),
      isConfidential: z.boolean(), jobStatus: z.enum(["active", "draft", "on_hold"]), location: text(300), seniorityLevel: text(80),
      experienceMinYears: z.number().min(0).max(50), experienceMaxYears: z.number().min(0).max(50).nullable(), educationLevel: text(100),
      salaryMin: z.number().min(0).max(1_000_000_000).nullable(), salaryMax: z.number().min(0).max(1_000_000_000).nullable(), salaryCurrency: text(10),
      requiredSkills: z.array(text(200)).max(100), niceToHaveSkills: z.array(text(200)).max(100), languagesRequired: z.array(text(100)).max(50),
    }).strict(),
  }).strict(),
  z.object({ action: z.literal("reextract_details") }).strict(),
]);

export const strategyWriteBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }).strict(),
  z.object({
    action: z.literal("submit"),
    rows: z.array(z.object({ rowId: z.string().min(1).max(200), used: z.boolean(), date: text(20), note: text(500) }).strict()).max(100),
  }).strict(),
  z.object({ action: z.literal("remove_proof"), rowId: z.string().min(1).max(200), proofId: z.string().min(1).max(300) }).strict(),
]);
