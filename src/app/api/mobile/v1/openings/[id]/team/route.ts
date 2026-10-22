import { primeStore } from "@/data/prime";
import { writeOpeningTeam } from "@/lib/openings/admin";
import { decideOn } from "@/lib/openings/writes";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { openingTeamBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** "Change the team": the web's setOpeningTeam. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(openingTeamBody, await req.json().catch(() => undefined), 'Send { "members": [{ "userId": "…", "role": "primary_recruiter" | … }] }.');
  if (!body.ok) return refuse(400, body.message);

  const decision = await decideOn(user, "opening.manage", { openingId: id }, MOBILE_OPENING_DEPS);
  if (!decision.ok) return refuse(decision.status, decision.message);
  const r = await writeOpeningTeam(user, id, body.value.members, MOBILE_OPENING_DEPS);
  if (!r.ok) return refuse(400, r.message);
  return ok<ActionResult>({ ok: true, message: "Team saved." });
}
