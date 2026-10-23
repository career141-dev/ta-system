import { primeStore } from "@/data/prime";
import { mobileCandidate } from "@/lib/mobile/candidate";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The website candidate drawer, with identical opening, stage and owner boundaries. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const result = mobileCandidate(user, id, appId);
  if (result.kind === "not_found") return refuse(404, "That candidate is no longer available on this opening.");
  if (result.kind === "forbidden") return refuse(403, result.message);
  return ok(result.payload);
}
