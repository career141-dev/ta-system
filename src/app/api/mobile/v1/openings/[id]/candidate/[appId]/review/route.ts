import { revalidatePath } from "next/cache";

import { primeStore } from "@/data/prime";
import { invalidateCandidate, markTablesStale } from "@/data/primeState";
import { writeCandidateReview } from "@/lib/candidates/reviewWrites";
import { convexQuery } from "@/lib/convexServer";
import { candidateReviewBody } from "@/lib/mobile/candidateBodies";
import { parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(candidateReviewBody, await req.json().catch(() => null), "Check the review details and try again.");
  if (!body.ok) return refuse(400, body.message);
  const result = await writeCandidateReview(user, id, appId, body.value, {
    convexQuery,
    revalidatePath,
    markTablesStale,
    invalidateCandidate,
    primeStore,
  });
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
