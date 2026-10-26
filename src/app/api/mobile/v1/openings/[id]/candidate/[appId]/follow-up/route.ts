import { revalidatePath } from "next/cache";

import { primeStore } from "@/data/prime";
import { resetStore } from "@/data/primeState";
import { sendCandidateFollowUp, stopCandidateFollowUp } from "@/lib/candidates/followUpWrites";
import { convexMutation, convexQuery } from "@/lib/convexServer";
import { candidateFollowUpBody } from "@/lib/mobile/candidateBodies";
import { parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(candidateFollowUpBody, await req.json().catch(() => null), "Choose a follow-up action and try again.");
  if (!body.ok) return refuse(400, body.message);

  const deps = { convexQuery, convexMutation, resetStore, revalidatePath };
  const result = body.value.action === "send"
    ? await sendCandidateFollowUp(user, id, appId, body.value.channel, deps)
    : await stopCandidateFollowUp(user, id, appId, deps);
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
