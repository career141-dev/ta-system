import { primeStore } from "@/data/prime";
import type { Stage } from "@/data/types";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { movePipelineBody } from "@/lib/mobile/pipelineBodies";
import { parseBody } from "@/lib/mobile/openingsBodies";
import type { PipelineMoveResult } from "@/lib/mobile/pipelineTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { movePipelineCandidates } from "@/lib/openings/pipelineWrites";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** One or several checked candidates through the website's normal stage rules. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(
    movePipelineBody,
    await req.json().catch(() => undefined),
    "Choose at least one candidate and an available stage.",
  );
  if (!body.ok) return refuse(400, body.message);

  const result = await movePipelineCandidates(
    user,
    id,
    [...new Set(body.value.applicationIds)],
    body.value.stage as Stage,
    body.value.reason,
    { ...MOBILE_OPENING_DEPS, primeApplications: () => primeStore({ allApplications: true }) },
  );
  if (!result.ok) return refuse(409, result.message);
  return ok<PipelineMoveResult>({ ok: true, message: result.message, moved: result.ok, notMoved: result.notOk });
}
