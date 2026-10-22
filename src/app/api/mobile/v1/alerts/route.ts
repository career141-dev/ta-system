import { NextResponse } from "next/server";

import { primeStore } from "@/data/prime";
import { mobileAlerts } from "@/lib/mobile/alerts";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The native app's alerts inbox: the web's /alerts page as data
 * (src/lib/mobile/alerts.ts). `?scope=everyone` is honoured only for the roles
 * the page lets switch; anyone else gets their own, as the web does.
 */
export async function GET(req: Request) {
  // Primed before the user is read: `currentUser` looks the account up in the store.
  await primeStore({ allApplications: true, followUps: true });
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }
  const wantEveryone = new URL(req.url).searchParams.get("scope") === "everyone";
  return NextResponse.json(mobileAlerts(user, wantEveryone), { headers: NO_STORE });
}
