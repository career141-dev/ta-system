import { primeStore } from "@/data/prime";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { mobileOpeningAdmin } from "@/lib/mobile/openings";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { decideOn } from "@/lib/openings/writes";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What the Overview's "Edit the details" and "Change the team" forms start from. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const decision = await decideOn(user, "opening.manage", { openingId: id }, MOBILE_OPENING_DEPS);
  if (!decision.ok) return refuse(decision.status, decision.message);
  const payload = mobileOpeningAdmin(user, id);
  return payload ? ok(payload) : refuse(404, "This opening is no longer available.");
}
