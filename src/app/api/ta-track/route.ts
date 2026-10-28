import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { convexActorForEmail, convexMutation, convexQuery } from "@/lib/convexServer";
import { canPairTaTracking, canViewTaTracking, validTrackingDate, type TrackingReport } from "@/lib/taTracking";
import { trackingLoginRequest } from "@/lib/taTrackingLogin";
import { trackingErrorMessage } from "@/lib/taTrackingError";
import { isTrackingSameOrigin } from "@/lib/taTrackingOrigin";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  await primeStore();
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (!canViewTaTracking(user.role)) return Response.json({ error: "Only admins and TA leads can view TA Track." }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const date = params.get("date") ?? "";
  const userId = params.get("userId") || undefined;
  if (!validTrackingDate(date)) return Response.json({ error: "Choose a date within the last 30 days." }, { status: 400 });
  if (userId && !repo.users().some(u => u.id === userId && canPairTaTracking(u.role))) return Response.json({ error: "TA not found." }, { status: 400 });
  try {
    const actor = await convexActorForEmail(user.email);
    if (!actor) throw new Error("Your account is not connected to the backend.");
    const report = await convexQuery<TrackingReport>("ta/tracking:report", { actorId: actor._id, date, ...(userId ? { userId } : {}) });
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: trackingErrorMessage(error) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  // Pairing/revocation use the signed-in account, never a supplied TA id.
  if (!isTrackingSameOrigin(req)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  await primeStore();
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (!canPairTaTracking(user.role)) return Response.json({ error: "Tracking is unavailable for this account." }, { status: 403 });
  try {
    const actor = await convexActorForEmail(user.email);
    if (!actor) throw new Error("Account unavailable.");
    const action = new URL(req.url).searchParams.get("action");
    if (action === "disconnect") {
      await convexMutation("ta/tracking:disconnect", { actorId: actor._id });
      return Response.json({ ok: true });
    }
    let login;
    try { login = trackingLoginRequest(await req.json()); }
    catch { return Response.json({ error: "Start sign-in from the browser tracker extension." }, { status: 400 }); }
    if (login.email !== user.email.trim().toLowerCase()) return Response.json({ error: `Sign in with ${login.email} to connect this browser. The current account is different.` }, { status: 403 });
    await convexMutation("ta/tracking:pair", { actorId: actor._id, tokenHash: login.tokenHash });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: trackingErrorMessage(error) }, { status: 503 });
  }
}
