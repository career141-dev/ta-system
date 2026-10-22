import { primeStore } from "@/data/prime";
import { mayReadOpening, mobileOpeningAdmin } from "@/lib/mobile/openings";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What the Overview's "Edit the details" and "Change the team" forms start from. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!mayReadOpening(user, id)) return refuse(403, "You may not have access to this opening, or it is no longer available.");
  const payload = mobileOpeningAdmin(user, id);
  return payload ? ok(payload) : refuse(404, "This opening is no longer available.");
}
