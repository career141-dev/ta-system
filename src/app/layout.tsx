import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { Flash } from "@/components/Flash";
import { Suspense } from "react";
import { currentUser } from "@/lib/session";
import { alertsFor } from "@/lib/sla";
import { repo } from "@/data/store";
import { DeskAssistant } from "@/components/DeskAssistant";
import { ConvexClientProvider } from "@/components/ConvexClientProvider";

export const metadata: Metadata = {
  title: "Career141 — Talent Acquisition",
  description: "Recruitment platform for the Career141 TA desk",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Null on the sign-in screen, which is the one page that renders without a
  // session — and therefore without the top bar.
  const user = await currentUser();
  // The badge counts the same alerts the Alerts page lists. It used to read a
  // stored count, which drifted: the 13 Sep audit found accounts showing one
  // where six were waiting.
  const alertCount = user ? alertsFor(user.id).length : 0;
  return (
    <html lang="en">
      <head>
        {/* The snippet card is typeset in Poppins, and the canvas takes its
            faces from the document — so they load here, not in the studio. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Poppins:wght@300;400;500;600;700&family=Jost:wght@300;400;500;600;700&family=Quicksand:wght@300;400;500;600;700&family=Montserrat:wght@300;400;500;600;700&family=Figtree:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        <ConvexClientProvider>
          {user ? <TopNav user={user} users={repo.users()} alertCount={alertCount} /> : null}
          <Suspense fallback={null}>
            <Flash />
          </Suspense>
          {children}
          {user ? <DeskAssistant /> : null}
        </ConvexClientProvider>
      </body>
    </html>
  );
}
