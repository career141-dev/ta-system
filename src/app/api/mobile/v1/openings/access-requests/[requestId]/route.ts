import { primeStore } from "@/data/prime";
import { decideAccess } from "@/lib/openings/admin";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { accessDecisionBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A lead approves or rejects a TA's request: the web's decideOpeningAccess. The backend checks the approver. */
export async function POST(req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  await primeStore({});
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(accessDecisionBody, await req.json().catch(() => undefined), 'Send { "decision": "approve" | "reject", "reason": "…" }.');
  if (!body.ok) return refuse(400, body.message);
  const r = await decideAccess(user, requestId, body.value.decision, body.value.reason, MOBILE_OPENING_DEPS);
  if (!r.ok) return refuse(403, r.message);
  return ok<ActionResult>({ ok: true, message: r.message });
}
