import { redirect } from "next/navigation";
import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";

/**
 * Where an invite link lands.
 *
 * Sign-up is invite-only (Clerk's "Restricted" mode), so this page only
 * completes for someone holding an invitation — the link carries the ticket.
 * Their role was set by the admin before the invite went out, so it applies
 * the moment they finish here.
 */
export default async function SignUpPage() {
  await primeStore({ allApplications: true });
  if (await currentUser()) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col justify-center px-6 py-16">
      <div className="mb-7">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Career141</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Accept your invite</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          Set up your sign-in. Access is by invitation only.
        </p>
      </div>
      <SignUp routing="hash" signInUrl="/signin" forceRedirectUrl="/" />
      <p className="mt-4 text-[12px] text-ink-faint">
        Already set up? <Link href="/signin" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
