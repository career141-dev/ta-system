import { primeStore } from "@/data/prime";
import { mayReadOpening } from "@/lib/mobile/openings";
import { MOBILE_PIPELINE_STAGES, mobilePipeline } from "@/lib/mobile/pipeline";
import type { PipelineStage } from "@/lib/mobile/pipelineTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** One native stage list, with the same seat and location boundaries as the web. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; stage: string }> }) {
  const { id, stage } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!mayReadOpening(user, id)) return refuse(403, "You are not on this opening.");
  if (!MOBILE_PIPELINE_STAGES.includes(stage as PipelineStage)) return refuse(404, "That pipeline stage is not available.");
  const workLocation = new URL(req.url).searchParams.get("workLocation") ?? undefined;
  const payload = mobilePipeline(user, id, stage as PipelineStage, workLocation);
  return payload ? ok(payload) : refuse(404, "That pipeline stage is not available to your role.");
}

