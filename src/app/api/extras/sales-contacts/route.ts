import { primeStore } from "@/data/prime";
import { currentUser } from "@/lib/session";
import { convexActorForEmail, convexMutation, convexQuery } from "@/lib/convexServer";
import { isTrackingSameOrigin } from "@/lib/taTrackingOrigin";

export const dynamic = "force-dynamic";

type Row = { id: string; name: string; email?: string; title: string; level: string };
type Page = { rows: Row[]; isDone: boolean; cursor: string };
type Summary = { counts: Record<string, number>; kept: number; finishedAt: number | null; running: { scanned: number; startedAt: number } | null };

async function adminActor() {
  await primeStore();
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in to continue." }, { status: 401 }) };
  if (user.role !== "admin") return { error: Response.json({ error: "Only an admin can use Extras." }, { status: 403 }) };
  const actor = await convexActorForEmail(user.email);
  if (!actor) return { error: Response.json({ error: "Your account is not connected to the backend." }, { status: 503 }) };
  return { actor };
}

/** ?segment=automobile switches every call to the automobile list. */
const moduleOf = (p: URLSearchParams) => (p.get("segment") === "automobile" ? "extras/automobileContacts" : "extras/salesContacts");

const failed = (e: unknown) =>
  Response.json({ error: e instanceof Error ? e.message.replace(/^.*Uncaught Error: /s, "").slice(0, 200) : "Could not load." }, { status: 503 });

/** ?summary=1 → counts and last refresh; otherwise one page of rows for the table. */
export async function GET(req: Request) {
  const { actor, error } = await adminActor();
  if (error) return error;
  const p = new URL(req.url).searchParams;
  const mod = moduleOf(p);
  try {
    if (p.get("summary")) {
      return Response.json(await convexQuery<Summary>(`${mod}:summary`, { actorId: actor._id }), { headers: { "Cache-Control": "no-store" } });
    }
    const page = await convexQuery<Page>(`${mod}:list`, {
      actorId: actor._id,
      level: p.get("level") || undefined,
      hasEmail: p.get("hasEmail") === "1",
      search: p.get("q") || undefined,
      cursor: p.get("cursor") || null,
      limit: 100,
    });
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}

/** The Refresh button. */
export async function POST(req: Request) {
  if (!isTrackingSameOrigin(req)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  const { actor, error } = await adminActor();
  if (error) return error;
  try {
    await convexMutation(`${moduleOf(new URL(req.url).searchParams)}:start`, { actorId: actor._id });
    return Response.json({ ok: true });
  } catch (e) { return failed(e); }
}
