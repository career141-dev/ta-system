import { primeStore } from "@/data/prime";
import { can } from "@/lib/auth";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { newClientBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { NewClientResult } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { saveNewClient } from "@/lib/openings/create";
import { currentUser } from "@/lib/session";
import { safeErrorMessage } from "@/lib/userError";

export const dynamic = "force-dynamic";

/** "+ New client" on the web's New opening: the create-client pop-up's save. */
export async function POST(req: Request) {
  await primeStore({});
  const user = await currentUser();
  if (!user) return signedOut();
  const decision = can(user, "client.manage");
  if (!decision.ok) return refuse(403, decision.message);
  const body = parseBody(newClientBody, await req.json().catch(() => undefined), "Send the new client's name, industry and contact.");
  if (!body.ok) return refuse(400, body.message);

  let client: NewClientResult["client"] | null;
  try {
    client = await saveNewClient(user, body.value, MOBILE_OPENING_DEPS);
  } catch (e) {
    return refuse(409, safeErrorMessage(e, "The client could not be saved. Try again."));
  }
  if (!client) return refuse(400, "Give the company a name.");
  return ok<NewClientResult>({ ok: true, message: `${client.name} added.`, client });
}
