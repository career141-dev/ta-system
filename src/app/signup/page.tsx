import Link from "next/link";
import { Show, SignUp } from "@clerk/nextjs";
import { currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { ReloadWhenSignedIn } from "@/components/ReloadWhenSignedIn";
import { redirect } from "next/navigation";
import { uiOnly } from "@/lib/uiOnly";

/**
 * Where an invite link lands.
 *
 * Sign-up is invite-only (Clerk's "Restricted" mode), so this page only
 * completes for someone holding an invitation — the link carries the ticket.
 * Their role was set by the admin before the invite went out, so it applies
 * the moment they finish here.
 */
export default async function SignUpPage() {
  // No sign-up without a sign-in service (lib/uiOnly.ts): pick a test account instead.
  if (uiOnly()) redirect("/signin");
  await primeStore({ allApplications: true });
  if (await currentUser()) return <ReloadWhenSignedIn />;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col justify-center px-6 py-16">
      <div className="mb-7">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Career141</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Accept your invite</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          Create your sign-in. You'll see the desk once you've been added to the team.
        </p>
      </div>
      <Show when="signed-out">
        <SignUp routing="hash" signInUrl="/signin" forceRedirectUrl="/signin" />
      </Show>
      <Show when="signed-in">
        <ReloadWhenSignedIn />
      </Show>
      <p className="mt-4 text-[12px] text-ink-faint">
        Already set up? <Link href="/signin" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
