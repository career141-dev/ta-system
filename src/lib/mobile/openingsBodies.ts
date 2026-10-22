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
