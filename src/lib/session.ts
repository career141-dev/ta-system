import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";
import { secret } from "./sign";
import { redirect } from "next/navigation";
import { repo } from "@/data/store";
import type { User } from "@/data/types";

export const SESSION_COOKIE = "c141_user";

/**
 * The session boundary.
 *
 * This is still stage-one auth — there is no password, and the sign-in screen
 * is a list of accounts. What the 13 September audit found, and what is fixed
 * here, is that it was not even that: with no cookie the server picked the TA
 * Lead, so signing out signed you straight back in, a hand-written cookie
 * naming any user was accepted, and a deactivated account still resolved.
 *
 * Three things now hold, and they are the three that have to survive the move
 * to a real provider:
 *
 *   **No session means no session.** Absent or unreadable, you land on the
 *   sign-in screen. Nothing is chosen for you.
 *   **The cookie is signed.** Editing it to name somebody else invalidates it.
 *   **A deactivated account does not resolve**, here and again in `lib/auth`.
 *
 * Swapping in Clerk replaces the body of `currentUser` and nothing else: every
 * caller downstream takes a `User`.
 */

function sign(id: string): string {
  return createHmac("sha256", secret()).update(id).digest("base64url");
}

export { signText, verifyText } from "./sign";

/** The cookie value for a user: their id, and proof the server wrote it. */
export function sessionValue(id: string): string {
  return `${id}.${sign(id)}`;
}

/** Reads a cookie back, returning the id only when the signature holds. */
export function readSession(raw: string | undefined): string | null {
  if (!raw) return null;
  const cut = raw.lastIndexOf(".");
  if (cut <= 0) return null;
  const id = raw.slice(0, cut);
  const given = Buffer.from(raw.slice(cut + 1));
  const want = Buffer.from(sign(id));
  if (given.length !== want.length) return null;
  return timingSafeEqual(given, want) ? id : null;
}

/** The signed-in user, or null. Never picks somebody for you. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const id = readSession(jar.get(SESSION_COOKIE)?.value);
  if (!id) return null;
  const user = repo.users().find((u) => u.id === id);
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
