import { z } from "zod";

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
