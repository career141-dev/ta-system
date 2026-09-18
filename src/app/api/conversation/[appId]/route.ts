import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { convexQuery } from "@/lib/convexServer";

/**
 * Everything already said to one candidate on one opening.
 *
 * The Follow-up row's WhatsApp and Email buttons used to send on the spot,
 * with no way to see what had gone before — a TA pressing Email could not tell
 * whether the candidate had answered yesterday. The buttons now open the
 * conversation first and send from there, and this is what it reads.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ appId: string }> }) {
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });

  const { appId } = await ctx.params;
  const [state, messages] = await Promise.all([
    convexQuery("ta/outreach:followUpState", { actorId: user.id, applicationId: appId }).catch(() => null),
    convexQuery("ta/outreach:messagesFor", { actorId: user.id, applicationId: appId, limit: 100 }).catch(() => []),
  ]);
  if (!state) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ state, messages });
}
