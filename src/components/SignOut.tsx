"use client";

import { useClerk } from "@clerk/nextjs";
import { devSignOut } from "@/app/actions";

/** Sign out: clears both Clerk session and local dev session cookies. */
export function SignOut({ className }: { className: string }) {
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
