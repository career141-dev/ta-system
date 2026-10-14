import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { Flash } from "@/components/Flash";
import { Suspense } from "react";
import Script from "next/script";
import { currentUser } from "@/lib/session";
import { alertsFor } from "@/lib/sla";
import { ClerkProvider, Show } from "@clerk/nextjs";
import { DeskAssistant } from "@/components/DeskAssistant";
import { FeedbackWidget } from "@/components/FeedbackWidget";
import { NavigationProgress } from "@/components/NavigationProgress";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { uiOnly } from "@/lib/uiOnly";
import { isTa } from "@/lib/auth";
import { cookies } from "next/headers";
import { WorkdayWorkspace } from "@/components/Workday";

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
  // The Aura mark (28 Sep), on a dark square so it reads on light and dark
  // browser tabs. Versioned filename: browsers cache icons hard.
  icons: { icon: "/aura-icon-v1.png", apple: "/aura-icon-v1.png" },
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
  const readAlertIds = user ? repo.readAlertIds(user.id) : new Set<string>();
  const alertCount = user ? alertsFor(user.id).filter((a) => !readAlertIds.has(a.id)).length : 0;
  const feedbackBadgeCount = user ? repo.unseenFeedbackCount(user) : 0;
  /*
   * Microsoft Clarity — heatmaps, session replays, rage clicks (28 Sep). Off
   * unless CLARITY_PROJECT_ID is set on the server; read per request, so the
   * one image serves with or without it.
   *
   * Every screen of this app is candidate data — names, phones, salaries — and
   * a replay would send it to Microsoft. So the whole body is masked HERE
   * (data-clarity-mask), not only in Clarity's dashboard setting, where one
   * click could undo it: replays show where people click and get stuck, as
   * grey blocks, never what the page said. The only thing we name is the
   * viewer's role, to filter replays by lead / TA.
   */
  const clarityId = (process.env.CLARITY_PROJECT_ID ?? "").trim();
  const clarity = /^[a-z0-9]{6,20}$/i.test(clarityId) ? clarityId : null;
  // Dark mode is opt-in per browser (components/ThemeToggle.tsx).
  const dark = (await cookies()).get("theme")?.value === "dark";
  return (
    <html lang="en" {...(dark ? { "data-theme": "dark" } : {})}>
      {/*
        No web fonts here. The app is set in the system face; the six families
        the snippet card is drawn in load on the snippets page, which is the only
        place they are used — they were a render-blocking stylesheet and thirty
        font files on every page of the desk.

        No Convex browser client either. Every read goes through the server, and
        nothing on any page subscribes, so the provider only opened a WebSocket
        and shipped the client library to every visitor for no reader.
      */}
      <body suppressHydrationWarning {...(clarity ? { "data-clarity-mask": "True" } : {})}>
        {clarity ? (
          <Script id="clarity" strategy="afterInteractive">
            {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${JSON.stringify(clarity)});` +
              (user ? `window.clarity("set","role",${JSON.stringify(user.role)});` : "")}
          </Script>
        ) : null}
        {uiOnly() ? (
          // Laptop screen work without a sign-in service (lib/uiOnly.ts).
          <>
            {user ? <TopNav user={user} alertCount={alertCount} feedbackBadgeCount={feedbackBadgeCount} /> : null}
            <Suspense fallback={null}>
              <NavigationProgress />
            </Suspense>
            <Suspense fallback={null}>
              <Flash />
            </Suspense>
            {user && ["ta", "ta_support", "ta_lead", "admin"].includes(user.role) ? <WorkdayWorkspace>{children}</WorkdayWorkspace> : children}
            {user ? <DeskAssistant /> : null}
            {user ? <FeedbackWidget isTa={isTa(user)} /> : null}
          </>
        ) : (
        <ClerkProvider signInUrl="/signin" signUpUrl="/signup" afterSignOutUrl="/signin">
          {user ? <TopNav user={user} alertCount={alertCount} feedbackBadgeCount={feedbackBadgeCount} /> : null}
          <Suspense fallback={null}>
            <NavigationProgress />
          </Suspense>
          <Suspense fallback={null}>
            <Flash />
          </Suspense>
          {user && ["ta", "ta_support", "ta_lead", "admin"].includes(user.role) ? <WorkdayWorkspace>{children}</WorkdayWorkspace> : children}
          {user ? <DeskAssistant /> : null}
          {user ? <FeedbackWidget isTa={isTa(user)} /> : null}
        </ClerkProvider>
        )}
      </body>
    </html>
  );
}
