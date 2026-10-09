/**
 * The Prepared CV as a file: the candidate's own CV with the CAREER141 box on
 * page 1, or the generated one-page CV when there is no file to stamp.
 *
 * One path for the drawer's download, the Prepared CV tab and the end-of-day
 * attachments (29 Sep), so all three show the same box in the same place. A
 * Word CV is converted first (lib/wordToPdf); it used to fall through to the
 * generated page, so the Director never saw the candidate's own CV.
 */

import type { Application, Candidate, Opening } from "@/data/types";
import { buildPreparedCv, stampCareer141Box, type CvAnnotation, type StampedBox } from "./pdf";
import { boxContent } from "./preparedCv";
import { isWordFile, wordToPdf } from "./wordToPdf";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { internalUploadUrl } from "./convexServer";

export interface PreparedCvFile {
  bytes: Uint8Array;
  /** Where the box landed (points from page 1's top-left); null when nothing was stamped. */
  box: StampedBox | null;
  page: { width: number; height: number };
  /** True when there was no CV file to stamp and the generated page was used. */
  generated: boolean;
}

/** The candidate's own CV as PDF bytes, or null when there is none to stamp. */
export async function originalCvPdf(c: Candidate): Promise<ArrayBuffer | Buffer | null> {
  if (!isConvex()) return null;
  const link = await backend.cvLink({ id: null }, c.id, false);
  if (!link.ok || !link.url) return null;
  const res = await fetch(internalUploadUrl(link.url));
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  const name = link.fileName ?? c.cvFileName ?? "";
  return isWordFile(name) ? await wordToPdf(Buffer.from(bytes), name) : bytes;
}

export async function preparedCvFile(
  app: Application,
  c: Candidate,
  opening: Opening | null,
  opts: {
    /** Replaces what the desk holds — the old query-string preview. */
    annotation?: CvAnnotation;
    /** Replaces the saved position — for a one-off preview. */
    at?: { x: number; y: number };
  } = {},
): Promise<PreparedCvFile> {
  const annotation = opts.annotation ?? boxContent(app, c, opening);
  const at = opts.at ?? app.preparedCvBox ?? undefined;

  try {
    const base = await originalCvPdf(c);
    if (base) {
      const stamped = await stampCareer141Box(base, annotation, at, c.cvFileName);
      return { ...stamped, generated: false };
    }
  } catch (err) {
    console.warn("[prepared-cv] Could not stamp the CV file; using the generated page:", (err as Error).message);
  }

  const profile = isConvex() ? await backend.candidateProfile({ id: null }, c.id).catch(() => null) : null;
  const { pdf } = buildPreparedCv(
    {
      fullName: c.fullName,
      // A correction made on the email is the page's heading too, not only the box's.
      currentTitle: annotation.currentDesignation !== undefined ? annotation.currentDesignation : c.currentTitle,
      currentEmployer: annotation.currentCompany !== undefined ? annotation.currentCompany : c.currentEmployer,
      location: c.location,
      totalExperienceYears: c.totalExperienceYears,
      educationDegree: c.educationDegree,
      educationInstitution: c.educationInstitution,
      summary: profile?.summary ?? null,
      career: profile?.career ?? [],
      education: profile?.education ?? [],
      skills: c.skills ?? [],
      languages: profile?.languages ?? [],
      certifications: profile?.certifications ?? [],
    },
    annotation,
    at,
  );
  return {
    bytes: new Uint8Array(pdf),
    // The generated page is laid out around its own text; only a real CV is dragged on.
    box: null,
    page: { width: 595, height: 842 },
    generated: true,
  };
}
