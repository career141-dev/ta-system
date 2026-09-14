import { timingSafeEqual } from "node:crypto";
import { nightly } from "@/lib/dbMatch";

/**
 * The nightly run: database matches for every open job. Called by a scheduler (cron, launchd, or a Convex cron on the
 * live system) with `Authorization: Bearer $C141_CRON_SECRET`.
 *
 * No secret set means no endpoint — a job that adds candidates to openings is
 * not something to leave open to anyone who guesses the URL.
 */
export const maxDuration = 800;

export async function POST(req: Request) {
  const secret = (process.env.C141_CRON_SECRET ?? "").trim();
  if (!secret) return new Response("Not configured", { status: 404 });
  const sent = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Forbidden", { status: 403 });
  const result = await nightly();
  return Response.json(result);
}
