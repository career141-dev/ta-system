"use client";

import { SignOutButton } from "@clerk/nextjs";
import { devSignOut } from "@/app/actions";

/** Sign out: through Clerk normally, or by clearing the development sign-in in UI-only mode (lib/uiOnly.ts). */
export function SignOut({ className }: { className: string }) {
  if (process.env.NEXT_PUBLIC_C141_UI_ONLY === "on" && process.env.NODE_ENV !== "production") {
    return (
      <form action={devSignOut}>
        <button className={className}>Sign out</button>
      </form>
    );
  }
  return (
    <SignOutButton redirectUrl="/signin">
      <button className={className}>Sign out</button>
    </SignOutButton>
  );
}
