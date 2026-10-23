import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { allows } from "@/lib/auth";
import { safeErrorMessage } from "@/lib/userError";

export const HEADHUNT_MAX_BYTES = 10 * 1024 * 1024;
const HEADHUNT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export interface HeadHuntFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HeadHuntUploadDeps {
  convexMutation: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  internalUploadUrl: (url: string) => string;
  put: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
}

export type HeadHuntUploadResult =
  | { ok: true; id: string; fileName: string }
  | { ok: false; status: 400 | 403 | 404 | 413 | 500 | 501 | 502; message: string };

/** The web and native upload routes use this one capability decision. */
export function mayUploadHeadHuntCv(user: User, openingId: string): { ok: true } | { ok: false; status: 403 | 404; message: string } {
  if (!repo.opening(openingId)) return { ok: false, status: 404, message: "That opening no longer exists. Reload the page." };
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  if (!allows(user, "opening.act", { openingId, assignment })) {
    return { ok: false, status: 403, message: "You are not on this opening, so you cannot add CVs to it." };
  }
  return { ok: true };
}

/** Store and queue one CV without reading or logging any of its contents. */
export async function queueHeadHuntCv(
  user: User,
  openingId: string,
  workLocationId: string | undefined,
  file: HeadHuntFile,
  deps: HeadHuntUploadDeps,
): Promise<HeadHuntUploadResult> {
  if (!file.size) return { ok: false, status: 400, message: "Choose a CV file first." };
  if (file.size > HEADHUNT_MAX_BYTES) {
    return { ok: false, status: 413, message: `${file.name} is over 10 MB. Save a smaller PDF and try again.` };
  }
  if (!HEADHUNT_TYPES.has(file.type) && !/\.(pdf|docx?)$/i.test(file.name)) {
    return { ok: false, status: 400, message: `${file.name} is not a PDF or a Word document.` };
  }
  const allowed = mayUploadHeadHuntCv(user, openingId);
  if (!allowed.ok) return allowed;
  if (!isConvex()) {
    return { ok: false, status: 501, message: "CV files are read by the candidate database, which this local build is not connected to." };
  }

  try {
    const url = await deps.convexMutation<string>("ta/cv:uploadUrl", { actorId: user.id });
    const put = await deps.put(deps.internalUploadUrl(url), {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: Buffer.from(await file.arrayBuffer()),
    });
    if (!put.ok) return { ok: false, status: 502, message: `${file.name} could not be stored (${put.status}). Try again.` };
    const { storageId } = (await put.json()) as { storageId: string };
    const { cvUploadId } = await deps.convexMutation<{ cvUploadId: string }>("ta/hhUpload:queue", {
      actorId: user.id,
      openingId,
      workLocationId,
      storageId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || "application/pdf",
    });
    return { ok: true, id: cvUploadId, fileName: file.name };
  } catch (error) {
    // Candidate details and file bytes never enter logs; callers receive the
    // existing safe sentence instead.
    return { ok: false, status: 500, message: safeErrorMessage(error, `${file.name} could not be queued. Try again.`) };
  }
}

