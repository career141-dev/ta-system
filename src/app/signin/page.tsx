import { redirect } from "next/navigation";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { signInAs } from "@/app/actions";
import { ROLE_LABEL } from "@/data/types";
import { primeStore } from "@/data/prime";

/**
 * The sign-in screen.
 *
 * It is a list of accounts, not a password prompt, and it says so: this build
 * runs on invented data and has no identity provider behind it. What it does
 * do is make signing in an act. Before the 13 September audit there was no
 * screen at all — the server chose the TA Lead for anyone who arrived, which
 * made the account menu's "Sign out" a button that did nothing.
 */
export default async function SignInPage() {
  await primeStore({ allApplications: true });
  if (await currentUser()) redirect("/");
  const users = repo.users().filter((u) => u.isActive);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col justify-center px-6 py-16">
      <div className="mb-7">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Career141
        </div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Talent Acquisition</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          Choose an account to continue. This build has no identity provider and no
          passwords — the desk it runs on is invented data.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-rule bg-card">
        {users.map((u, i) => (
          <form key={u.id} action={signInAs}>
            <input type="hidden" name="userId" value={u.id} />
            <button
              type="submit"
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-paper ${
                i > 0 ? "border-t border-rule" : ""
              }`}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper text-[11px] font-semibold text-ink-soft">
                {u.initials}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{u.name}</span>
                <span className="block text-[11px] text-ink-faint">{ROLE_LABEL[u.role]}</span>
              </span>
            </button>
          </form>
        ))}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
        Sessions are signed, so editing the cookie signs you out rather than in.
        Deactivated accounts do not appear here and do not resolve.
      </p>
    </main>
  );
}
