import { z } from "zod";

export const candidateProfileBody = z
  .object({
    field: z.enum(["email", "phone", "name"]),
    value: z.string().max(500),
  })
  .strict();
