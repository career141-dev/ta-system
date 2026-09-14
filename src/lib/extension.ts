/**
 * The bridge the browser extension talks to.
 *
 * What this is, and what it deliberately is not: a TA opens a LinkedIn profile
 * themselves, in their own logged-in session, looks at it, and presses a button
 * to file it against an opening. The extension reads the page that is already
 * on their screen. It does not navigate, does not queue, does not run in the
 * background, and does not touch a profile the TA has not opened — those are
 * the lines that separate this from the scraping LinkedIn shut Proxycurl down
 * for, and they are enforced here as well as in the extension: every capture
 * carries the URL it came off and the person who pressed the button.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ProfileCapture } from "@/data/types";
import { dataDir } from "@/data/dataDir";

const DATA_DIR = dataDir();
const TOKEN_FILE = path.join(DATA_DIR, "extension-token.txt");

/**
 * A shared secret so a stray page cannot post into the vault. It lives beside
 * the JSON store and is created on first read; at connection this is replaced
 * by the signed-in user's Clerk session.
 */
export function extensionToken(): string {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Not written yet.
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token);
  return token;
}

/** The extension runs on a chrome-extension:// origin, so every reply needs
 *  these and every route needs an OPTIONS handler. */
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-C141-Token",
  "Access-Control-Max-Age": "86400",
};

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

export function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS });
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
export function authorised(req: Request): boolean {
  const sent = req.headers.get("x-c141-token") ?? "";
  const real = extensionToken();
  const a = Buffer.from(sent);
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Anything the extension sends is untrusted page content: trim it, cap it,
 *  and never let a field decide its own length. */
const str = (v: unknown, max = 400): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

export function normaliseCapture(raw: unknown, capturedBy: string): ProfileCapture | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sourceUrl = str(r.sourceUrl, 500);
  if (!sourceUrl || !/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(sourceUrl)) return null;

  const list = <T,>(v: unknown, map: (x: Record<string, unknown>) => T, cap: number): T[] =>
    Array.isArray(v) ? v.filter((x) => x && typeof x === "object").slice(0, cap).map((x) => map(x as Record<string, unknown>)) : [];

  return {
    fullName: str(r.fullName, 120),
    headline: str(r.headline, 300),
    currentTitle: str(r.currentTitle, 160),
    currentCompany: str(r.currentCompany, 160),
    location: str(r.location, 160),
    about: str(r.about, 4000),
    connectionDegree: str(r.connectionDegree, 12),
    openToWork: r.openToWork === true,
    experience: list(
      r.experience,
      (x) => ({ title: str(x.title, 160) ?? "", company: str(x.company, 160) ?? "", dates: str(x.dates, 80) }),
      25,
    ).filter((x) => x.title || x.company),
    education: list(
      r.education,
      (x) => ({ school: str(x.school, 160) ?? "", detail: str(x.detail, 200) }),
      15,
    ).filter((x) => x.school),
    skills: Array.isArray(r.skills)
      ? (r.skills.map((s) => str(s, 80)).filter(Boolean) as string[]).slice(0, 60)
      : [],
    email: str(r.email, 200),
    phone: str(r.phone, 40),
    sourceUrl,
    capturedAt: Date.now(),
    capturedBy,
  };
}
