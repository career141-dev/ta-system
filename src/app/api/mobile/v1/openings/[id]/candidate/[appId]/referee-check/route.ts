import { primeStore } from "@/data/prime";
import { checkCandidateReferee } from "@/lib/candidates/referenceChecks";
import { convexQuery } from "@/lib/convexServer";
import { candidateRefereeCheckBody } from "@/lib/mobile/candidateBodies";
import { parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { search, serperConfigured } from "@/lib/serper";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(candidateRefereeCheckBody, await req.json().catch(() => null), "Choose a referee and try again.");
  if (!body.ok) return refuse(400, body.message);
  const result = await checkCandidateReferee(user, id, body.value.refereeId, appId, { convexQuery, searchConfigured: serperConfigured, search });
  if (result.ok || result.notice) return ok(result);
  return refuse(result.status === 503 ? 502 : result.status, result.message);
}
