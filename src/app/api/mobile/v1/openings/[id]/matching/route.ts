import { after } from "next/server";

import { primeStore } from "@/data/prime";
import { startMatching } from "@/lib/openings/matching";
import { decideOn } from "@/lib/openings/writes";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import type { ActionResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** "Run matching": the web's findMatchesNow. The run happens after the response. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();

  const decision = await decideOn(user, "opening.sourcing", { openingId: id }, MOBILE_OPENING_DEPS);
  if (!decision.ok) return refuse(decision.status, decision.message);
  const r = startMatching(user, id, { revalidatePath: MOBILE_OPENING_DEPS.revalidatePath, schedule: (work) => after(work) });
  if (!r.ok) return refuse(409, r.message);
  return ok<ActionResult>({ ok: true, message: r.message });
}
