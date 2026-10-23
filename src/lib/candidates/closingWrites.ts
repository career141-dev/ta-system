import { repo } from "@/data/store";
import type { Currency, SalaryBasis, User } from "@/data/types";
import { colomboLocalToInstant } from "@/lib/calendar";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";

export type CandidateClosingWrite =
  | { action: "offer"; salary: number; salaryBasis: SalaryBasis; currency: Currency; startDate: string; terms: string }
  | { action: "respond"; offerId: string; status: "accepted" | "declined" | "withdrawn"; reason: string }
  | { action: "place"; offerId: string; joinDate: string };

export type CandidateClosingResult =
  | { ok: true; message: string; placementId?: string }
  | { ok: false; status: 400 | 403 | 404; message: string };

function clean(value: string): string {
  return value.trim();
}

function colomboDay(value: string): number | null {
  const day = value.trim();
  return day ? colomboLocalToInstant(`${day}T09:00`) : null;
}

/** The website and phone close a candidate through the same records and policy checks. */
export async function writeCandidateClosing(
  user: User,
  openingId: string,
  applicationId: string,
  input: CandidateClosingWrite,
  deps: Pick<OpeningWriteDeps, "convexQuery" | "revalidatePath">,
): Promise<CandidateClosingResult> {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) {
    return { ok: false, status: 404, message: "That candidate is not on this opening." };
  }

  const offer = input.action === "offer" ? null : repo.offer(input.offerId) ?? null;
  if (input.action !== "offer" && (!offer || offer.applicationId !== app.id || offer.openingId !== opening.id)) {
    return { ok: false, status: 404, message: "That offer no longer exists." };
  }

  const decision = await decideOn(user, "opening.act", { openingId, ownerTaId: app.ownerTaId }, deps);
  if (!decision.ok) return decision;

  let result: CandidateClosingResult;
  if (input.action === "offer") {
    const saved = repo.makeOffer({
      applicationId,
      salary: input.salary,
      salaryBasis: input.salaryBasis,
      currency: input.currency,
      startDate: colomboDay(input.startDate),
      terms: clean(input.terms) || null,
      byUserId: user.id,
    });
    result = saved.ok
      ? { ok: true, message: "Offer recorded." }
      : { ok: false, status: 400, message: saved.message };
  } else if (input.action === "respond") {
    const saved = repo.respondToOffer({
      offerId: input.offerId,
      status: input.status,
      reason: clean(input.reason),
      byUserId: user.id,
    });
    result = saved.ok
      ? { ok: true, message: input.status === "accepted" ? "Offer accepted." : input.status === "withdrawn" ? "Offer withdrawn." : "Offer declined." }
      : { ok: false, status: 400, message: saved.message };
  } else {
    const joinDate = colomboDay(input.joinDate);
    if (joinDate === null) return { ok: false, status: 400, message: "A placement needs a join date." };
    const saved = repo.recordPlacement({ offerId: input.offerId, joinDate, byUserId: user.id });
    result = saved.ok
      ? { ok: true, message: "Placement recorded.", placementId: saved.id }
      : { ok: false, status: 400, message: saved.message };
  }

  if (result.ok) {
    deps.revalidatePath(`/openings/${openingId}/candidate/${applicationId}`);
    deps.revalidatePath("/placements");
  }
  return result;
}
