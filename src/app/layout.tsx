import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { Flash } from "@/components/Flash";
import { Suspense } from "react";
import { currentUser } from "@/lib/session";
import { alertsFor } from "@/lib/sla";
import { ClerkProvider } from "@clerk/nextjs";
import { DeskAssistant } from "@/components/DeskAssistant";
import { primeStore } from "@/data/prime";

export const metadata: Metadata = {
  title: "Career141 — Talent Acquisition",
  description: "Recruitment platform for the Career141 TA desk",
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
        <ClerkProvider signInUrl="/signin" signUpUrl="/signup" afterSignOutUrl="/signin">
          {user ? <TopNav user={user} alertCount={alertCount} /> : null}
          <Suspense fallback={null}>
            <Flash />
          </Suspense>
          {children}
          {user ? <DeskAssistant /> : null}
        </ClerkProvider>
      </body>
    </html>
  );
}
