"use client";

import { useClerk } from "@clerk/nextjs";
import { devSignOut } from "@/app/actions";

/** Sign out: clears both Clerk session and local dev session cookies. */
export function SignOut({ className }: { className: string }) {
  // UI-only mode (lib/uiOnly.ts) has no ClerkProvider, so useClerk() would
  // throw and take the top menu with it (review of PR #40, 24 Sep).
  if (process.env.NEXT_PUBLIC_C141_UI_ONLY === "on" && process.env.NODE_ENV !== "production") {
    return (
      <form action={devSignOut}>
        <button className={className}>Sign out</button>
      </form>
    );
  }
  return <ClerkSignOut className={className} />;
}

function ClerkSignOut({ className }: { className: string }) {
  const clerk = useClerk();

  async function handleSignOut(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (clerk && clerk.loaded) {
        await clerk.signOut({ redirectUrl: "/signin" });
      }
    } catch {
      // ignore if Clerk wasn't loaded or not signed in through Clerk
    }
    await devSignOut();
  }

  return (
    <form onSubmit={handleSignOut} action={devSignOut}>
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
