import { revalidatePath } from "next/cache";

import { primeStore } from "@/data/prime";
import { markTablesStale } from "@/data/primeState";
import { writeCandidateCall } from "@/lib/candidates/callWrites";
import { convexQuery } from "@/lib/convexServer";
import { candidateCallBody } from "@/lib/mobile/candidateBodies";
import { parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(candidateCallBody, await req.json().catch(() => null), "Check the call details and try again.");
  if (!body.ok) return refuse(400, body.message);
  const result = await writeCandidateCall(user, id, appId, body.value, { convexQuery, revalidatePath, markTablesStale });
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
