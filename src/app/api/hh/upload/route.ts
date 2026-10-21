import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { primeStore, resetStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { convexMutation, convexQuery, internalUploadUrl } from "@/lib/convexServer";
import { safeErrorMessage } from "@/lib/userError";

/**
 * "Upload headhunted CV" on an opening's TA Follow-up (28 Sep).
 *
 * POST takes one file for one opening, stores it, and queues it on the CV
 * platform's own extraction (convex/ta/hhUpload.ts) — nothing here reads the
 * CV. GET says where each queued file has got to, for the panel's progress.
 * A route rather than a server action because a CV is bigger than an action's
 * 1 MB body.
 */
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });
const refuse = (message: string, status = 400) => answer({ ok: false, message }, status);

/** The signed-in person, if they work this opening. */
async function mayUpload(openingId: string) {
  await primeStore({ openingId });
  const user = await currentUser();
  if (!user) return { user: null, message: "Your session has ended. Sign in again.", status: 401 };
  if (!repo.opening(openingId)) return { user: null, message: "That opening no longer exists. Reload the page.", status: 404 };
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  if (!allows(user, "opening.act", { openingId, assignment })) {
    return { user: null, message: "You are not on this opening, so you cannot add CVs to it.", status: 403 };
  }
  return { user, message: "", status: 200 };
}

export async function POST(req: NextRequest) {
  // The size before the body is read, so a large upload is refused unread.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) return refuse("That file is over 10 MB. Save a smaller PDF and try again.", 413);
  await primeStore({});
  if (!(await currentUser())) return refuse("Your session has ended. Sign in again.", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return refuse("The upload could not be read. Try again.");
  const openingId = String(form.get("openingId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return refuse("Choose a CV file first.");
  if (file.size > MAX_BYTES) return refuse(`${file.name} is over 10 MB. Save a smaller PDF and try again.`);
  if (!TYPES.has(file.type) && !/\.(pdf|docx?)$/i.test(file.name)) return refuse(`${file.name} is not a PDF or a Word document.`);

  const { user, message, status } = await mayUpload(openingId);
  if (!user) return refuse(message, status);
  if (!isConvex()) {
    // The file store keeps no files and runs no extraction.
    return refuse("CV files are read by the candidate database, which this local build is not connected to.", 501);
  }

  try {
    const url = await convexMutation<string>("ta/cv:uploadUrl", { actorId: user.id });
    const put = await fetch(internalUploadUrl(url), {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: Buffer.from(await file.arrayBuffer()),
    });
    if (!put.ok) return refuse(`${file.name} could not be stored (${put.status}). Try again.`, 502);
    const { storageId } = (await put.json()) as { storageId: string };
    const { cvUploadId } = await convexMutation<{ cvUploadId: string }>("ta/hhUpload:queue", {
      actorId: user.id,
      openingId,
      workLocationId: String(form.get("workLocationId") ?? "") || undefined,
      storageId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || "application/pdf",
    });
    return answer({ ok: true, id: cvUploadId, fileName: file.name });
  } catch (e) {
    console.warn("[hh upload]", (e as Error).message);
    return refuse(safeErrorMessage(e, `${file.name} could not be queued. Try again.`), 500);
  }
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
