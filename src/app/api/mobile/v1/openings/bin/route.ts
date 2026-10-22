import { primeStore } from "@/data/prime";
import { binOpenings } from "@/lib/openings/writes";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { binOpeningsBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { BinResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Delete one or several openings — into the Bin for seven days, as on the web.
 * Each is checked on its own (opening.manage); none allowed is a 403.
 */
export async function POST(req: Request) {
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(binOpeningsBody, await req.json().catch(() => undefined), 'Send { "openingIds": ["…"] } with 1 to 200 openings.');
  if (!body.ok) return refuse(400, body.message);

  const r = await binOpenings(user, body.value.openingIds, MOBILE_OPENING_DEPS);
  if (r.deleted === 0) return refuse(403, r.message);
  return ok<BinResult>({ ok: true, message: r.message, binned: r.deleted, problems: r.problems });
}
