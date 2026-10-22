import { NextResponse } from "next/server";

import { primeStore } from "@/data/prime";
import { colomboGreeting } from "@/lib/calendar";
import { mobileHome } from "@/lib/mobile/home";
import type { HomePayload } from "@/lib/mobile/homeTypes";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The native app's home screen: the web dashboard (src/app/page.tsx) for the
 * signed-in user's role, as data. Clerk verifies the bearer session in
 * `currentUser`; the variant follows the server-side role, never a parameter.
 */
export async function GET() {
  // Primed before the user is read: `currentUser` looks the account up in the store.
  await primeStore({ allApplications: true, followUps: true });
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  /*
   * A client account has no desk home. The web's `/` does not redirect a
   * client — it falls through to the TA view, whose interview list is not
   * scoped to the client's openings — so matching it would hand a client
   * other clients' candidate names. The app is for the desk; refuse instead.
   */
  if (user.role === "client") {
    return NextResponse.json(
      { error: "forbidden", message: "This account has no desk home." },
      { status: 403, headers: NO_STORE },
    );
  }

  const payload: HomePayload = {
    apiVersion: 1,
    greeting: colomboGreeting(),
    generatedAt: Date.now(),
    home: mobileHome(user),
  };
  return NextResponse.json(payload, { headers: NO_STORE });
}
