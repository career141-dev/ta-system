import { primeStore } from "@/data/prime";
import { decideOn, writeWorkingStage } from "@/lib/openings/writes";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { parseBody, setWorkingStageBody } from "@/lib/mobile/openingsBodies";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** This person's own stage on the job (100% / Follow-up / Add-on): the web's setWorkingStage. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(setWorkingStageBody, await req.json().catch(() => undefined), 'Send { "stage": "100%" | "Follow-up" | "Add-on" }.');
  if (!body.ok) return refuse(400, body.message);

  const decision = await decideOn(user, "opening.act", { openingId: id }, MOBILE_OPENING_DEPS);
  if (!decision.ok) return refuse(decision.status, decision.message);
  const r = await writeWorkingStage(user, id, body.value.stage, MOBILE_OPENING_DEPS);
  if (!r.ok) return refuse(409, r.message);
  return ok<ActionResult>({ ok: true, message: `Working stage set to ${body.value.stage}.` });
}
