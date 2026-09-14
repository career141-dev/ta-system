/**
 * The server's signing key, and signatures for short texts it hands out and
 * must trust when they come back: session cookies (lib/session) and the Ask
 * chat's proposed actions (lib/deskActions). No framework imports, so tests
 * and scripts can use it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signing key. In development it falls back to a fixed string so a fresh
 * checkout works; in production a missing key is fatal rather than silently
 * making every cookie forgeable.
 */
export function secret(): string {
  const fromEnv = process.env.C141_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "C141_SESSION_SECRET is missing. Sessions cannot be signed, so the platform will not start.",
    );
  }
  return "dev-only-session-key-not-for-production";
}


export function signText(text: string): string {
  return createHmac("sha256", `proposal:${secret()}`).update(text).digest("base64url");
}

export function verifyText(text: string, signature: string): boolean {
  const given = Buffer.from(signature);
  const want = Buffer.from(signText(text));
  return given.length === want.length && timingSafeEqual(given, want);
}
