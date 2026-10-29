import { repo } from "@/data/store";
import type { CallKind, CallOutcome, User } from "@/data/types";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";

export interface CandidateCallWrite {
  kind: CallKind;
  outcome: CallOutcome;
  body: string;
}

export type CandidateCallResult =
  | { ok: true; message: string }
  | { ok: false; status: 403 | 404; message: string };

/** One manual call-log write for the web form and the native candidate sheet. */
export async function writeCandidateCall(
  user: User,
  openingId: string,
  applicationId: string,
  input: CandidateCallWrite,
  deps: Pick<OpeningWriteDeps, "convexQuery" | "revalidatePath" | "markTablesStale">,
): Promise<CandidateCallResult> {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) {
    return { ok: false, status: 404, message: "That candidate is not on this opening." };
  }

  const decision = await decideOn(user, "opening.act", { openingId, ownerTaId: app.ownerTaId }, deps);
  if (!decision.ok) return decision;

  repo.recordCall({
    applicationId,
    kind: input.kind,
    outcome: input.outcome,
    body: input.body,
    structured: null,
    source: "manual",
    recordedBy: user.id,
  });
  deps.markTablesStale();
  deps.revalidatePath("/alerts");
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  return { ok: true, message: "Call logged." };
}
