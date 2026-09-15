import { auth, currentUser as clerkUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { repo } from "@/data/store";
import type { User } from "@/data/types";

/**
 * The session boundary.
 *
 * Identity comes from Clerk; the desk account comes from our own roster. The
 * two are joined on the Clerk account's verified email — the same key the
 * Convex bridge (`convex/ta/actor.ts`) already matches on.
 *
 * The three rules the stage-one cookie established still hold:
 *
 *   **No session means no session.** No Clerk session, or one whose email has
 *   no desk account, lands on the sign-in screen. Nothing is chosen for you.
 *   **Identity cannot be forged.** Clerk signs and verifies the session; there
 *   is no longer a cookie of ours to hand-edit.
 *   **A deactivated account does not resolve**, here and again in `lib/auth`.
 *
 * Every caller downstream still takes a `User`.
 */

export { signText, verifyText } from "./sign";

/** The Clerk account's verified email addresses, lower-cased. Empty when signed out. */
export async function clerkEmails(): Promise<string[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const account = await clerkUser();
  if (!account) return [];
  return account.emailAddresses
    .filter((e) => e.verification?.status === "verified")
    .map((e) => e.emailAddress.trim().toLowerCase());
}

/** The signed-in user, or null. Never picks somebody for you. */
export async function currentUser(): Promise<User | null> {
  // Development and test runs only — see lib/devSignin.ts. Refused in production builds.
  const { devSigninEnabled, readDevSession, DEV_SESSION_COOKIE } = await import("./devSignin");
  if (devSigninEnabled()) {
    const { cookies } = await import("next/headers");
    const id = readDevSession((await cookies()).get(DEV_SESSION_COOKIE)?.value);
    if (id) {
      const user = repo.users().find((u) => u.id === id);
      if (user?.isActive) return user;
    }
  }
  const emails = await clerkEmails();
  if (emails.length === 0) return null;
  const match = () => repo.users().find((u) => emails.includes(u.email.trim().toLowerCase()));
  let user = match();
  if (!user) {
    // Possibly added since the roster was loaded — look once more before refusing.
    const { refreshUsers } = await import("@/data/prime");
    await refreshUsers();
    user = match();
  }
  if (!user || !user.isActive) return null;
  return user;
}

/**
 * The signed-in user, or the sign-in screen. Every page and every server action
 * that touches data goes through this.
 */
export async function getCurrentUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  return user;
}

/**
 * The signed-in user, allowed to see a page — or a 404.
 *
 * Top-level pages were reachable by anybody signed in: a client account could
 * open the whole database or the reports. A refused page is a 404 rather than
 * a "not allowed", so a page's existence is not itself disclosed.
 */
export async function pageUser(capability: import("./auth").Capability): Promise<User> {
  const user = await getCurrentUser();
  const { can } = await import("./auth");
  if (!can(user, capability).ok) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return user;
}
