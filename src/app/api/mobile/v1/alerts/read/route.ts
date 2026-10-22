import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { primeStore } from "@/data/prime";
import { markAlerts } from "@/lib/alerts/readState";
import { convexMutation } from "@/lib/convexServer";
import { parseMarkAlertsBody } from "@/lib/mobile/alerts";
import type { MarkAlertsResult } from "@/lib/mobile/alertsTypes";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The app's Mark read / Mark unread / Mark all as read. The same service as the
 * web's `markAlertsAsRead` / `markAlertsAsUnread` (src/lib/alerts/readState.ts),
 * so both mark the same alerts and tell the bell the same way.
 */
export async function POST(req: Request) {
  await primeStore({ allApplications: true, followUps: true });
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  const body: unknown = await req.json().catch(() => undefined);
  const parsed = parseMarkAlertsBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid", message: parsed.message }, { status: 400, headers: NO_STORE });
  }

  const outcome = await markAlerts(user, parsed.request, { revalidatePath, convexMutation });
  if (!outcome.ok) {
    return NextResponse.json({ error: "invalid", message: outcome.message }, { status: 400, headers: NO_STORE });
  }
  const result: MarkAlertsResult = { ok: true, message: outcome.message, changed: outcome.changed };
  return NextResponse.json(result, { headers: NO_STORE });
}
