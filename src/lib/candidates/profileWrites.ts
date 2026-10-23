import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";
import { seatFor, visibleToSeat } from "@/lib/visibility";

export type CandidateProfileField = "email" | "phone" | "name";
export interface CandidateProfileWrite {
  field: CandidateProfileField;
  value: string;
}
export type CandidateProfileResult =
  | { ok: true; message: string }
  | { ok: false; status: 400 | 403 | 404; message: string };

/** The candidate profile write shared by the web form and the native API. */
export async function writeCandidateProfile(
  user: User,
  openingId: string,
  applicationId: string,
  input: CandidateProfileWrite,
  deps: Pick<OpeningWriteDeps, "convexQuery" | "revalidatePath">,
): Promise<CandidateProfileResult> {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) {
    return { ok: false, status: 404, message: "That candidate is not on this opening." };
  }
  const candidate = repo.candidate(app.candidateId);
  if (!candidate) return { ok: false, status: 404, message: "That candidate no longer exists." };

  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  const seat = seatFor(user, assignment?.role ?? null, onStrategy);
  if (visibleToSeat([app], seat).length === 0) {
    return { ok: false, status: 403, message: "This candidate belongs to another recruiter on this opening." };
  }
  const decision = await decideOn(user, "opening.act", { openingId, ownerTaId: app.ownerTaId }, deps);
  if (!decision.ok) return decision;

  const raw = input.value.trim().replace(/\s+/g, " ");
  if (input.field === "name") {
    if (raw.length < 2 || /^unnamed candidate$/i.test(raw)) {
      return { ok: false, status: 400, message: "Type their full name." };
    }
    if (raw.length > 120) {
      return { ok: false, status: 400, message: "That name is too long — type just their full name." };
    }
    repo.updateCandidateContact(candidate.id, { fullName: raw });
    deps.revalidatePath(`/openings/${openingId}`, "layout");
    return { ok: true, message: "Name saved." };
  }

  repo.updateCandidateContact(candidate.id, { [input.field]: raw || null });
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  return { ok: true, message: input.field === "email" ? "Email saved." : "Phone saved." };
}
