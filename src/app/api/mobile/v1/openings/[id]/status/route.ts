import { primeStore } from "@/data/prime";
import { OPENING_STATUS_LABEL } from "@/lib/openingStatus";
import { decideOn, writeOpeningStatus } from "@/lib/openings/writes";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { parseBody, setStatusBody } from "@/lib/mobile/openingsBodies";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The status menu (open, on hold, placed, closed): the web's setOpeningStatus. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(setStatusBody, await req.json().catch(() => undefined), 'Send { "status": "open" | "on_hold" | "filled" | "closed" }.');
  if (!body.ok) return refuse(400, body.message);

  const decision = await decideOn(user, "opening.manage", { openingId: id }, MOBILE_OPENING_DEPS);
  if (!decision.ok) return refuse(decision.status, decision.message);
  writeOpeningStatus(id, body.value.status, MOBILE_OPENING_DEPS);
  return ok<ActionResult>({ ok: true, message: `Status set to ${OPENING_STATUS_LABEL[body.value.status]}.` });
}
