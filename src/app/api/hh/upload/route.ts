import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { primeStore, resetStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { currentUser } from "@/lib/session";
import { convexMutation, convexQuery, internalUploadUrl } from "@/lib/convexServer";
import { safeErrorMessage } from "@/lib/userError";
import { HEADHUNT_MAX_BYTES, mayUploadHeadHuntCv, queueHeadHuntCv } from "@/lib/openings/hhUpload";

/**
 * "Upload headhunted CV" on an opening's TA Follow-up (28 Sep).
 *
 * POST takes one file for one opening, stores it, and queues it on the CV
 * platform's own extraction (convex/ta/hhUpload.ts) — nothing here reads the
 * CV. GET says where each queued file has got to, for the panel's progress.
 * A route rather than a server action because a CV is bigger than an action's
 * 1 MB body.
 */
const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });
const refuse = (message: string, status = 400) => answer({ ok: false, message }, status);

/** The signed-in person, if they work this opening. */
async function mayUpload(openingId: string) {
  await primeStore({ openingId });
  const user = await currentUser();
  if (!user) return { user: null, message: "Your session has ended. Sign in again.", status: 401 };
  const decision = mayUploadHeadHuntCv(user, openingId);
  if (!decision.ok) return { user: null, message: decision.message, status: decision.status };
  return { user, message: "", status: 200 };
}

export async function POST(req: NextRequest) {
  // The size before the body is read, so a large upload is refused unread.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > HEADHUNT_MAX_BYTES + 64 * 1024) return refuse("That file is over 10 MB. Save a smaller PDF and try again.", 413);
  await primeStore({});
  if (!(await currentUser())) return refuse("Your session has ended. Sign in again.", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return refuse("The upload could not be read. Try again.");
  const openingId = String(form.get("openingId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) return refuse("Choose a CV file first.");

  const { user, message, status } = await mayUpload(openingId);
  if (!user) return refuse(message, status);
  const result = await queueHeadHuntCv(
    user,
    openingId,
    String(form.get("workLocationId") ?? "") || undefined,
    file,
    { convexMutation, internalUploadUrl, put: fetch },
  );
  // Keep the website's existing response contract: a file discovered as too
  // large after parsing has always been a 400. The early content-length guard
  // above remains the only 413 response on this route.
  return result.ok ? answer(result) : refuse(result.message, result.status === 413 ? 400 : result.status);
}

export async function GET(req: NextRequest) {
  const openingId = req.nextUrl.searchParams.get("openingId") ?? "";
  const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 20);
  const { user, message, status } = await mayUpload(openingId);
  if (!user) return refuse(message, status);
  if (!isConvex() || ids.length === 0) return answer({ ok: true, files: [] });
  const files = await convexQuery<{ id: string; state: string }[]>("ta/hhUpload:status", { actorId: user.id, cvUploadIds: ids });
  // Someone just landed in TA Follow-up: the next render has to read them.
  if (files.some((f) => f.state === "done" || f.state === "held")) {
    resetStore();
    revalidatePath(`/openings/${openingId}`, "layout");
  }
  return answer({ ok: true, files });
}

/** "Try again" on a CV that could not be read: the stored file is read again (28 Oct). */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { openingId?: string; id?: string } | null;
  const { user, message, status } = await mayUpload(String(body?.openingId ?? ""));
  if (!user) return refuse(message, status);
  if (!body?.id) return refuse("That upload no longer exists.");
  if (!isConvex()) return refuse("CV files are read by the candidate database, which this local build is not connected to.", 501);
  try {
    await convexMutation("ta/hhUpload:retry", { actorId: user.id, cvUploadId: body.id });
    return answer({ ok: true });
  } catch (e) {
    return refuse(safeErrorMessage(e, "The CV could not be sent for reading again. Try again."), 500);
  }
}
