// convex/lib/activityLog.ts — write to pipelineEvents for audit trail
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

export async function logActivity(
  ctx: MutationCtx,
  params: {
    actorId?: Id<"users">;
    actorAgent?: "agent1" | "agent2" | "agent3" | "agent4" | "agent5" | "agent6" | "agent7" | "agent8";
    actorType: "user" | "agent" | "system";
    applicationId?: Id<"applications">;
    candidateId?: Id<"candidates">;
    jobId: Id<"jobs">;
    eventType: string;
    fromStage?: string;
    toStage?: string;
    notes?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await ctx.db.insert("pipelineEvents", {
    ...params,
    metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
    createdAt: Date.now(),
  });
}
