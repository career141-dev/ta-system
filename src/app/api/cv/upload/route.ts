import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { primeStore, resetStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { convexMutation, internalUploadUrl } from "@/lib/convexServer";

/**
 * A CV added from the candidate sheet (21 Sep: "uploading one from here is not
 * built yet", and a headhunted person could never reach Director review).
 *
 * A route rather than a server action because a CV is bigger than an action's
 * 1 MB body. It checks the person may act on this opening, puts the file in
 * the backend's storage, and attaches it to this application's candidate —
 * never intake, which would try to match or create a candidate of its own.
 */
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
};

const answer = (ok: boolean, message: string, status = ok ? 200 : 400) =>
  NextResponse.json({ ok, message }, { status });

export async function POST(req: NextRequest) {
  // Who is asking, and how big the upload says it is, before reading any of
  // it: the body was read into memory first, so anybody could make the server
  // hold large uploads without being signed in (review of PR #2, 21 Sep).
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) return answer(false, "That file is over 10 MB. Save a smaller PDF and try again.", 413);
  await primeStore({});
  if (!(await currentUser())) return answer(false, "Your session has ended. Sign in again.", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return answer(false, "The upload could not be read. Try again.");
  const applicationId = String(form.get("applicationId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return answer(false, "Choose a CV file first.");
  if (file.size > MAX_BYTES) return answer(false, "That file is over 10 MB. Save a smaller PDF and try again.");
  const kind = TYPES[file.type] ?? (/\.(pdf|docx?)$/i.test(file.name) ? "file" : null);
  if (!kind) return answer(false, "A CV has to be a PDF or a Word document.");

  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return answer(false, "Your session has ended. Sign in again.", 401);
  const app = repo.application(applicationId);
  if (!app) return answer(false, "That application no longer exists. Reload the page.", 404);
  const assignment = repo.assignmentFor(app.openingId, user.id) ?? null;
  if (!allows(user, "opening.act", { openingId: app.openingId, assignment })) {
    return answer(false, "You are not on this opening, so you cannot add a CV to it.", 403);
  }

  if (!isConvex()) {
    // The file store keeps no files, so there is nowhere to put one.
    return answer(false, "CV files are kept by the candidate database, which this local build is not connected to.", 501);
  }

  try {
    const url = await convexMutation<string>("ta/cv:uploadUrl", { actorId: user.id });
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const put = await fetch(internalUploadUrl(url), {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: fileBuffer,
    });
    if (!put.ok) return answer(false, `The file could not be stored (${put.status}). Try again.`, 502);
    const { storageId } = (await put.json()) as { storageId: string };
    const res = await convexMutation<{ replaced: boolean }>("ta/cv:attach", {
      actorId: user.id,
      applicationId,
      storageId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || "application/octet-stream",
    });

    // Auto-extract references from the uploaded CV
    try {
      const { extractAndSaveReferees } = await import("@/lib/refereeExtractor");
      await extractAndSaveReferees(app.candidateId, fileBuffer, file.type);
    } catch (refErr) {
      console.warn("[cv upload] Referee extraction skipped:", refErr);
    }

    resetStore();
    revalidatePath(`/openings/${app.openingId}`, "layout");
    revalidatePath(`/openings/${app.openingId}/candidate/${app.id}`);
    revalidatePath(`/openings/${app.openingId}/reference`);
    revalidatePath(`/openings/${app.openingId}/pipeline`, "layout");
    revalidatePath(`/candidates/${app.candidateId}`);
    return answer(true, res.replaced ? `CV replaced with ${file.name}.` : `CV added: ${file.name}.`);
  } catch (e) {
    console.warn("[cv upload]", (e as Error).message);
    return answer(false, `The CV could not be saved: ${(e as Error).message.replace(/^.*?Uncaught Error:\s*/s, "").split("\n")[0].slice(0, 200)}`, 500);
  }
}
