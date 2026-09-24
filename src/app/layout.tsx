import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { Flash } from "@/components/Flash";
import { Suspense } from "react";
import { currentUser } from "@/lib/session";
import { alertsFor } from "@/lib/sla";
import { ClerkProvider, Show } from "@clerk/nextjs";
import { DeskAssistant } from "@/components/DeskAssistant";
import { NavigationProgress } from "@/components/NavigationProgress";
import { primeStore } from "@/data/prime";
import { uiOnly } from "@/lib/uiOnly";

// Every page depends on who is signed in and reads the database, so nothing is
// rendered at build time. Without this, `next build` pre-rendered the 404 page,
// whose layout loads the store — so an image could not be built without a live
// database to point at.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Career141 — Talent Acquisition",
  description: "Recruitment platform for the Career141 TA desk",
  // Without an icon the browser asked for /favicon.ico, which does not exist,
  // and the request fell through to a page render.
  icons: { icon: "/career141-logo.png" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Who is asking needs only the users table. The desk — every application,
  // and the people being chased — is loaded only for someone signed in: the
  // sign-in screen has no badge to count.
  await primeStore();
  // Null on the sign-in screen, which is the one page that renders without a
  // session — and therefore without the top bar.
  const user = await currentUser();
  // Follow-ups too: the alert badge below counts them, and a follow-up whose
  // candidate is not held is dropped from that count rather than miscounted.
  if (user) await primeStore({ allApplications: true, followUps: true });
  // The badge counts the same alerts the Alerts page lists. It used to read a
  // stored count, which drifted: the 13 Sep audit found accounts showing one
  // where six were waiting.
  const alertCount = user ? alertsFor(user.id).length : 0;
  return (
    <html lang="en">
      {/*
        No web fonts here. The app is set in the system face; the six families
        the snippet card is drawn in load on the snippets page, which is the only
        place they are used — they were a render-blocking stylesheet and thirty
        font files on every page of the desk.

        No Convex browser client either. Every read goes through the server, and
        nothing on any page subscribes, so the provider only opened a WebSocket
        and shipped the client library to every visitor for no reader.
      */}
      <body suppressHydrationWarning>
        {uiOnly() ? (
          // Laptop screen work without a sign-in service (lib/uiOnly.ts).
          <>
            {user ? <TopNav user={user} alertCount={alertCount} /> : null}
            <Suspense fallback={null}>
              <NavigationProgress />
            </Suspense>
            <Suspense fallback={null}>
              <Flash />
            </Suspense>
            {children}
            {user ? <DeskAssistant /> : null}
          </>
        ) : (
        <ClerkProvider signInUrl="/signin" signUpUrl="/signup" afterSignOutUrl="/signin">
          {user ? <TopNav user={user} alertCount={alertCount} /> : null}
          <Suspense fallback={null}>
            <NavigationProgress />
          </Suspense>
          <Suspense fallback={null}>
            <Flash />
          </Suspense>
          {children}
          {user ? <DeskAssistant /> : null}
        </ClerkProvider>
        )}
      </body>
    </html>
  );
}
