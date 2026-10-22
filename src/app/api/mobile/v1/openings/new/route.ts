import { primeStore } from "@/data/prime";
import { can } from "@/lib/auth";
import { mobileNewOpening } from "@/lib/mobile/newOpening";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The web's /openings/new: the clients, the TAs a lead may assign, and the form's lists. */
export async function GET() {
  await primeStore({});
  const user = await currentUser();
  if (!user) return signedOut();
  const decision = can(user, "opening.create");
  if (!decision.ok) return refuse(403, decision.message);
  return ok(mobileNewOpening(user));
}
