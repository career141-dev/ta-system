import { primeStore } from "@/data/prime";
import { requestAccess } from "@/lib/openings/admin";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { accessRequestBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A TA asks the lead to be added to this opening: the web's requestOpeningAccess. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({});
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(accessRequestBody, await req.json().catch(() => undefined), 'Send { "reason": "…" } (it may be empty).');
  if (!body.ok) return refuse(400, body.message);
  const r = await requestAccess(user, id, body.value.reason, MOBILE_OPENING_DEPS);
  if (!r.ok) return refuse(403, r.message);
  return ok<ActionResult>({ ok: true, message: r.message });
}
