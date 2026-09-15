import { createHmac, timingSafeEqual } from "crypto";
import { secret } from "./sign";

/**
 * Signing in without Clerk, for development and automated testing only.
 *
 * Clerk is how people sign in. But a test run cannot type a password into
 * Clerk's form, and a developer's machine should not need a Clerk account per
 * desk role to try the screens as each of them. So when — and only when —
 * `C141_DEV_SIGNIN=on` AND the app is not a production build, the sign-in
 * screen also lists the desk accounts, and choosing one sets a signed cookie.
 *
 * Both conditions are checked on every read, not once at start-up: a production
 * build ignores the switch entirely, whatever the environment says, so this
 * cannot become a way into a deployed desk.
 */

export const DEV_SESSION_COOKIE = "c141_dev_user";

export function devSigninEnabled(): boolean {
  return process.env.C141_DEV_SIGNIN === "on" && process.env.NODE_ENV !== "production";
}

const sign = (id: string) => createHmac("sha256", `dev-signin:${secret()}`).update(id).digest("base64url");

export function devSessionValue(id: string): string {
  return `${id}.${sign(id)}`;
}

/** The account id in a dev cookie, when the signature holds and dev sign-in is on. */
export function readDevSession(raw: string | undefined): string | null {
  if (!devSigninEnabled() || !raw) return null;
  const cut = raw.lastIndexOf(".");
  if (cut <= 0) return null;
  const id = raw.slice(0, cut);
  const given = Buffer.from(raw.slice(cut + 1));
  const want = Buffer.from(sign(id));
  return given.length === want.length && timingSafeEqual(given, want) ? id : null;
}
