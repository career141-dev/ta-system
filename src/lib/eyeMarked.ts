import type { Application, Candidate, LinkVaultEntry, ReviewRound } from "@/data/types";

export interface EyeMarkedProgress {
  id: string;
  name: string;
  linkedinUrl: string;
  status: string;
  blocked: boolean;
  complete: boolean;
  applicationId: string | null;
}

export function eyeMarkedHasCv(
  candidate: Pick<Candidate, "cvFileName" | "cvFileMissing"> | undefined,
  app: Pick<Application, "cvFileId" | "cvFileName"> | undefined,
) {
  return !candidate?.cvFileMissing && !!(candidate?.cvFileName || app?.cvFileId || app?.cvFileName);
}

/** Contacted people can be waiting on a CV; a CV already received needs action before EOD (13 Oct). */
export function eyeMarkedProgress(
  row: Pick<LinkVaultEntry, "id" | "name" | "linkedinUrl" | "outcome" | "conversationLog">,
  app: Pick<Application, "id" | "stage" | "cvFileId" | "cvFileName"> | undefined,
  candidate: Pick<Candidate, "fullName" | "cvFileName" | "cvFileMissing"> | undefined,
  submitted: boolean,
): EyeMarkedProgress {
  const base = {
    id: row.id, name: row.name || candidate?.fullName || row.linkedinUrl,
    linkedinUrl: row.linkedinUrl, applicationId: app?.id ?? null,
  };
  const state = (status: string, blocked = false, complete = false): EyeMarkedProgress => ({ ...base, status, blocked, complete });
  if (submitted) return state("Submitted to the Director", false, true);
  if (app && ["director_shortlist", "client_shortlist", "interview", "offer", "placed"].includes(app.stage))
    return state("Progressed beyond Director Review", false, true);
  if (row.outcome === "declined" || app?.stage === "rejected" || app?.stage === "dropped_out")
    return state("Not proceeding", false, true);
  const hasCv = eyeMarkedHasCv(candidate, app);
  if (app?.stage === "director_review" && hasCv) return state("Ready for the Director’s email", false, true);
  if (hasCv || row.outcome === "cv_received" || row.outcome === "shortlisted")
    return state(app ? "Move to Director Review" : "Link the CV and add to TA Follow-up", true);
  if (row.outcome === "unreachable") return state("Contact attempted — unreachable");
  if (row.outcome === "contacted" || row.outcome === "responded" || row.conversationLog.length > 0)
    return state("Contacted — waiting for CV");
  return state("Call the candidate and request their CV", true);
}

export function eyeMarkedItems(
  rows: LinkVaultEntry[], apps: Application[], candidates: Candidate[], rounds: ReviewRound[],
): EyeMarkedProgress[] {
  const sent = new Set(rounds.filter((r) => r.kind === "director").flatMap((r) => r.applicationIds));
  return rows.filter((r) => r.isEyeMarked).map((row) => {
    const app = apps.find((a) => a.openingId === row.openingId && a.candidateId === row.candidateId);
    const candidate = candidates.find((c) => c.id === row.candidateId);
    return eyeMarkedProgress(row, app, candidate, !!app && sent.has(app.id));
  });
}
