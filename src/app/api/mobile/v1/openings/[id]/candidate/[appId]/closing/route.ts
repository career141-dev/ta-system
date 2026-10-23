import { revalidatePath } from "next/cache";

import { primeStore } from "@/data/prime";
import { writeCandidateClosing } from "@/lib/candidates/closingWrites";
import { convexQuery } from "@/lib/convexServer";
import { candidateClosingBody } from "@/lib/mobile/candidateBodies";
import { parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(candidateClosingBody, await req.json().catch(() => null), "Check the offer details and try again.");
  if (!body.ok) return refuse(400, body.message);
  const result = await writeCandidateClosing(user, id, appId, body.value, { convexQuery, revalidatePath });
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
