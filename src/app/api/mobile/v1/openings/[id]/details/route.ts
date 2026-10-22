import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { writeOpeningDetails } from "@/lib/openings/admin";
import { decideOn } from "@/lib/openings/writes";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { openingDetailsBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * "Edit the details": the web's updateOpening. An opening with work locations
 * keeps them as they are — its locations and headcount come from them, and
 * they are edited on the web's locations editor, not here.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(openingDetailsBody, await req.json().catch(() => undefined), "Send every field of the details form as text.");
  if (!body.ok) return refuse(400, body.message);

  const decision = await decideOn(user, "opening.manage", { openingId: id }, MOBILE_OPENING_DEPS);
  if (!decision.ok) return refuse(decision.status, decision.message);
  const existing = repo.opening(id)?.workLocations;
  const r = writeOpeningDetails(id, body.value, existing?.length ? existing : undefined, MOBILE_OPENING_DEPS);
  if (!r.ok) return refuse(400, r.message);
  return ok<ActionResult>({ ok: true, message: "Opening saved." });
}
