import { z } from "zod";

import { MOBILE_DIRECT_MOVE_STAGES } from "@/lib/openings/pipelineWrites";

/** Bodies accepted by native pipeline writes. */
export const movePipelineBody = z
  .object({
    applicationIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
    stage: z.enum(MOBILE_DIRECT_MOVE_STAGES as [string, ...string[]]),
    reason: z.string().trim().max(1000),
  })
  .strict();
