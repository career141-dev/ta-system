import Image from "next/image";
import { Show, SignIn } from "@clerk/nextjs";
import { clerkEmails, currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { devSigninEnabled } from "@/lib/devSignin";
import { devSignInAs } from "@/app/actions";
import { ReloadWhenSignedIn } from "@/components/ReloadWhenSignedIn";
import { uiOnly } from "@/lib/uiOnly";
import { AppVersion } from "@/components/AppVersion";
import { SignOut } from "@/components/SignOut";

/**
 * The sign-in screen.
 *
 * Clerk proves who you are; the desk roster decides whether you have an
 * account here. The third state — signed in to Clerk with an email the desk
 * does not know, or one that has been deactivated — is shown as itself rather
 * than bounced back to the Clerk form, which would redirect straight out again.
 */
export default async function SignInPage() {
  // A list of names. Nothing else on the desk is read here.
  await primeStore();
  // Signed in already: a full load, not redirect() — see ReloadWhenSignedIn.
  if (await currentUser()) return <ReloadWhenSignedIn />;
  const emails = await clerkEmails();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col justify-center px-6 py-16">
      {/* Aura's lettering is white on transparent, so it sits on its own dark
          panel whatever the page theme (28 Sep). */}
      <div className="mb-7 flex justify-center rounded-2xl bg-[#0b0b12] px-10 py-8">
        <Image src="/aura-logo-v1.png" alt="Aura — AI Unified Recruiter Agent" width={720} height={612} priority className="h-auto w-[220px]" />
      </div>
      <div className="mb-7">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Career141
        </div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Talent Acquisition</h1>
      </div>

      {/* Development and test runs only — never shown in a production build. */}
      {devSigninEnabled() && (
        <form action={devSignInAs} className="mb-6 rounded-lg border border-dashed border-warn/50 bg-warn-soft px-4 py-3">
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-warn">Development sign-in</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {repo.users().filter((u) => u.isActive).map((u) => (
              <button key={u.id} name="userId" value={u.id} className="rounded-full border border-rule bg-surface px-3 py-1 text-[12px] hover:bg-paper">
                {u.name} <span className="text-ink-faint">· {u.role.replace("_", " ")}</span>
              </button>
            ))}
          </div>
        </form>
      )}

      {uiOnly() ? null : emails.length === 0 ? (
        // The server can briefly see no session that the browser already has
        // (just after sign-in). Rendering <SignIn> then starts a second sign-in,
        // which Clerk refuses with a 400 and a blank card — so only render it
        // when the browser agrees nobody is signed in.
        <>
          <Show when="signed-out">
            <SignIn routing="hash" forceRedirectUrl="/" />
          </Show>
          <Show when="signed-in">
            <ReloadWhenSignedIn />
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
          <SignOut className="mt-4 rounded-lg border border-rule px-3 py-1.5 text-[12.5px] hover:bg-paper" />
        </div>
      )}
      <AppVersion className="mt-6 block text-center" />
    </main>
  );
}
