import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { noticePeriodToDays } from "@/lib/answered";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";

const REVIEW_NOTE_MAX = 2000;

export interface CandidateReviewDetail {
  label: string;
  value: string;
}

export type CandidateReviewWrite =
  | {
      action: "details";
      currentSalary: string;
      currentSalaryCurrency: string;
      expectedSalary: string;
      expectedSalaryCurrency: string;
      noticePeriod: string;
      currentDesignation: string;
      currentCompany: string;
      customDetails: CandidateReviewDetail[];
    }
  | { action: "add_note"; note: string }
  | { action: "remove_note"; noteId: string };

export type CandidateReviewResult =
  | { ok: true; message: string }
  | { ok: false; status: 400 | 403 | 404; message: string };

export interface CandidateReviewDeps extends Pick<OpeningWriteDeps, "convexQuery" | "revalidatePath" | "markTablesStale"> {
  invalidateCandidate: (candidateId: string) => void;
  primeStore: (options: { candidateIds: string[]; openingId: string; allApplications?: boolean }) => Promise<unknown>;
}

function withCurrency(amountValue: string, currencyValue: string): string {
  const amount = amountValue.trim();
  const currency = currencyValue.trim();
  if (!amount) return "";
  if (currency && /^\d/.test(amount) && !new RegExp(`^${currency}\\b`, "i").test(amount)) {
    return `${currency} ${amount}`;
  }
  return amount;
}

/** Director-review details and notes share one policy and persistence path on web and phone. */
export async function writeCandidateReview(
  user: User,
  openingId: string,
  applicationId: string,
  input: CandidateReviewWrite,
  deps: CandidateReviewDeps,
): Promise<CandidateReviewResult> {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) {
    return { ok: false, status: 404, message: "That candidate is not on this opening." };
  }

  const capability = input.action === "details" ? "opening.act" : "review.note";
  const decision = await decideOn(user, capability, { openingId, ownerTaId: input.action === "details" ? app.ownerTaId : null }, deps);
  if (!decision.ok) return decision;

  if (input.action === "add_note") {
    const text = input.note.trim();
    if (!text) return { ok: false, status: 400, message: "Write the note first." };
    if (text.length > REVIEW_NOTE_MAX) {
      return { ok: false, status: 400, message: `That note is ${text.length} characters. Keep it under ${REVIEW_NOTE_MAX}.` };
    }
    if (!repo.addReviewNote(applicationId, user.id, user.role, text)) {
      return { ok: false, status: 404, message: "That application no longer exists." };
    }
    deps.markTablesStale();
    deps.revalidatePath(`/openings/${openingId}`, "layout");
    return { ok: true, message: "Note added." };
  }

  if (input.action === "remove_note") {
    const target = app.reviewNotes?.find((note) => note.id === input.noteId);
    if (!target) return { ok: false, status: 404, message: "That note is already gone." };
    if (target.by !== user.id) {
      return { ok: false, status: 403, message: "Only the person who wrote a note can remove it." };
    }
    repo.removeReviewNote(applicationId, input.noteId);
    deps.markTablesStale();
    deps.revalidatePath(`/openings/${openingId}`, "layout");
    return { ok: true, message: "Note removed." };
  }

  const candidate = repo.candidate(app.candidateId);
  if (!candidate) return { ok: false, status: 404, message: "That candidate no longer exists." };
  deps.invalidateCandidate(candidate.id);
  await deps.primeStore({ candidateIds: [candidate.id], openingId, allApplications: true });

  const currentSalary = withCurrency(input.currentSalary, input.currentSalaryCurrency);
  const expectedSalary = withCurrency(input.expectedSalary, input.expectedSalaryCurrency);
  const noticeRaw = input.noticePeriod.trim();
  let noticeDays: number | null = null;
  let noticeText: string | null = null;
  if (noticeRaw) {
    noticeText = noticeRaw;
    const parsedDays = noticePeriodToDays(noticeRaw);
    if (parsedDays !== null) noticeDays = parsedDays;
    else {
      const numeric = Number(noticeRaw);
      if (Number.isFinite(numeric) && numeric >= 0) noticeDays = Math.round(numeric);
    }
  }

  const customNotes = input.customDetails
    .map(({ label, value }) => ({ label: label.trim(), value: value.trim() }))
    .filter(({ value }) => Boolean(value))
    .map(({ label, value }) => label ? `${label}: ${value}` : value);
  const patch: Parameters<typeof repo.saveReviewDetails>[3] = {
    currentSalary: currentSalary || null,
    expectedSalary: expectedSalary || null,
    noticePeriodDays: noticeDays,
    noticePeriod: noticeText || (noticeDays !== null ? (noticeDays === 0 ? "Immediate" : `${noticeDays} days`) : null),
  };
  const freshCandidate = repo.candidate(app.candidateId) ?? candidate;
  const designation = input.currentDesignation.trim() || null;
  const company = input.currentCompany.trim() || null;
  if (designation !== ((freshCandidate.currentTitle ?? "").trim() || null)) patch.currentTitle = designation;
  if (company !== ((freshCandidate.currentEmployer ?? "").trim() || null)) patch.currentEmployer = company;

  try {
    repo.saveReviewDetails(app.id, app.candidateId, customNotes, patch);
  } catch (error) {
    const message = (error as Error).message || "";
    if (!message.includes("Someone else changed this record") && !message.includes("conflict")) throw error;
    deps.invalidateCandidate(app.candidateId);
    deps.markTablesStale();
    await deps.primeStore({ candidateIds: [app.candidateId], openingId, allApplications: true });
    repo.saveReviewDetails(app.id, app.candidateId, customNotes, patch);
  }

  deps.markTablesStale();
  deps.invalidateCandidate(app.candidateId);
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  deps.revalidatePath(`/candidates/${app.candidateId}`);
  return { ok: true, message: "Details saved." };
}
