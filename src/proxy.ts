import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { uiOnly } from "@/lib/uiOnly";

/**
 * Puts the Clerk session on every request so `auth()` can read it.
 *
 * It deliberately protects nothing itself. Refusal stays where it already was —
 * `getCurrentUser` redirects, `pageUser` 404s, `must` throws — so the webhook
 * and cron routes under /api, which authenticate with their own secrets, keep
 * working without a Clerk session.
 */
const clerk = clerkMiddleware();

// UI-only laptop mode has no sign-in service to hand the request to (lib/uiOnly.ts).
export default function proxy(req: NextRequest, event: NextFetchEvent) {
  if (uiOnly()) return NextResponse.next();
  return clerk(req, event);
}

export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
