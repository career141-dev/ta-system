import "server-only";
import type { User } from "@/data/types";
import { repo } from "@/data/store";
import { allows, can } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import * as backend from "@/data/convex/backend";
import { internalUploadUrl } from "@/lib/convexServer";

/**
 * Who may open a candidate's CV — one test for every route that hands one out
 * (api/cv/[candidateId], api/cv/zip).
 *
 * Through an application (`appId`), access is the opening's, the same test the
 * CV tab makes, so a client contact who may not search the database still
 * sees the CV of someone on their shortlist. Without one it needs database
 * access. The store must already hold the application.
 */
export function mayOpenCv(user: User, candidateId: string, appId: string | null): boolean {
  if (!appId) return can(user, "database.read").ok;
  const app = repo.application(appId);
  if (!app || app.candidateId !== candidateId) return false;
  const assignment = repo.assignmentFor(app.openingId, user.id) ?? null;
  const seat = seatFor(user, assignment?.role ?? null);
  return allows(user, "opening.read", { openingId: app.openingId, assignment }) && (seat.stages === null || seat.stages.includes(app.stage));
}

export type CvBytes =
  | { ok: true; bytes: Buffer; fileName: string | null; contentType: string; isPdf: boolean }
  /** The file could not be read here; the browser may still reach it at `url`. */
  | { ok: false; url: string; fileName: string | null }
  | { ok: false; url?: undefined; status: number; detail: string };

/** A candidate's CV file, read through the server so internal storage addresses never reach the browser. */
export async function cvBytes(candidateId: string, download = false): Promise<CvBytes> {
  const link = await backend.cvLink({ id: null }, candidateId, download);
  if (!link.ok) return { ok: false, status: link.reason === "storage_unavailable" ? 503 : 404, detail: link.detail };

  try {
    const res = await fetch(internalUploadUrl(link.url));
    if (res.ok) {
      const rawType = res.headers.get("content-type") || link.fileType || "application/pdf";
      const isPdf =
        /pdf/i.test(rawType) || /\.pdf$/i.test(link.fileName ?? "") || !/\.(docx?|rtf|txt|png|jpe?g)$/i.test(link.fileName ?? "");
      return {
        ok: true,
        bytes: Buffer.from(await res.arrayBuffer()),
        fileName: link.fileName,
        contentType: isPdf ? "application/pdf" : rawType,
        isPdf,
      };
    }
  } catch (err) {
    console.warn("[cv proxy]", (err as Error).message);
  }
  return { ok: false, url: link.url, fileName: link.fileName };
}
