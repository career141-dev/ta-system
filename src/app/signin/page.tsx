import { redirect } from "next/navigation";
import { Show, SignIn, SignOutButton } from "@clerk/nextjs";
import { clerkEmails, currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";

/**
 * The sign-in screen.
 *
 * Clerk proves who you are; the desk roster decides whether you have an
 * account here. The third state — signed in to Clerk with an email the desk
 * does not know, or one that has been deactivated — is shown as itself rather
 * than bounced back to the Clerk form, which would redirect straight out again.
 */
export default async function SignInPage() {
  await primeStore({ allApplications: true });
  if (await currentUser()) redirect("/");
  const emails = await clerkEmails();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col justify-center px-6 py-16">
      <div className="mb-7">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Career141
        </div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Talent Acquisition</h1>
      </div>

      {emails.length === 0 ? (
        // The server can briefly see no session that the browser already has
        // (just after sign-in). Rendering <SignIn> then starts a second sign-in,
        // which Clerk refuses with a 400 and a blank card — so only render it
        // when the browser agrees nobody is signed in.
        <>
          <Show when="signed-out">
            <SignIn routing="hash" forceRedirectUrl="/" />
          </Show>
          <Show when="signed-in">
            <p className="text-[13px] text-ink-soft">
              Signing you in… <a href="/" className="underline">Continue</a>
            </p>
          </Show>
        </>
      ) : (
        <div className="rounded-lg border border-rule bg-card px-4 py-4">
          <p className="text-[13px] leading-relaxed">
            You are signed in as <span className="font-medium">{emails.join(", ")}</span>, but
            there is no active desk account for that address.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
            Ask an admin to add you on the People page, or sign in with a different account.
          </p>
          <SignOutButton redirectUrl="/signin">
            <button className="mt-4 rounded-lg border border-rule px-3 py-1.5 text-[12.5px] hover:bg-paper">
              Sign out
            </button>
          </SignOutButton>
        </div>
      )}
    </main>
  );
}
