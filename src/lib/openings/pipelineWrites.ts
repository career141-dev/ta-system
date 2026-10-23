import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import { STAGE_LABEL, type Stage, type User } from "@/data/types";
import { can } from "@/lib/auth";
import { BULK_STAGES } from "@/lib/bulkStages";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";
import { safeErrorMessage } from "@/lib/userError";

export const MOBILE_DIRECT_MOVE_STAGES = BULK_STAGES;

type PipelineMoveResult =
  | { ok: true; message: string }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

type PipelineWriteDeps = Pick<
  OpeningWriteDeps,
  "convexQuery" | "convexMutation" | "resetStore" | "revalidatePath"
> & { primeApplications?: () => Promise<void> };

function userName(id: string): string {
  return repo.users().find((user) => user.id === id)?.name ?? "another recruiter";
}

function refreshed(openingId: string, deps: PipelineWriteDeps): void {
  deps.resetStore();
  deps.revalidatePath(`/openings/${openingId}`, "layout");
}

/**
 * The website and phone's one-candidate pipeline move. It owns every policy
 * decision and storage call; callers only translate the result into their
 * transport (redirect banner on web, JSON on mobile).
 */
export async function movePipelineCandidate(
  user: User,
  openingId: string,
  applicationId: string,
  stage: Stage,
  reason: string,
  deps: PipelineWriteDeps,
): Promise<PipelineMoveResult> {
  const app = repo.application(applicationId);
  if (!app) return { ok: false, status: 404, message: "That record no longer exists — it may have been removed." };
  if (app.openingId !== openingId) return { ok: false, status: 409, message: "That record belongs to a different opening." };

  const decision = await decideOn(user, "opening.act", { openingId, ownerTaId: app.ownerTaId ?? null }, deps);
  if (!decision.ok) return decision;

  const decides = stage === "director_shortlist" ? "decide.director" : stage === "client_shortlist" ? "decide.client" : null;
  if (decides) {
    const verdict = can(user, decides, { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null });
    if (!verdict.ok) return { ok: false, status: 403, message: verdict.message };
  }

  if ((stage === "rejected" || stage === "dropped_out") && !reason.trim()) {
    return { ok: false, status: 400, message: stage === "rejected" ? "Say why they were rejected." : "Say why they dropped out." };
  }

  if (stage === "ta_follow_up" && ["ai_follow_up", "new_cv", "matched"].includes(app.stage)) {
    if (isConvex()) {
      try {
        const result = await deps.convexMutation<
          { ok: true; alreadyMine: boolean; setNumber: number | null } | { ok: false; ownerTaId: string }
        >("ta/applications:shortlist", { actorId: user.id, applicationId });
        refreshed(openingId, deps);
        if (!result.ok) return { ok: false, status: 409, message: `Already shortlisted by ${userName(result.ownerTaId)}.` };
      } catch (error) {
        return { ok: false, status: 409, message: safeErrorMessage(error, "They could not be shortlisted.") };
      }
    } else {
      repo.shortlist(applicationId, user.id);
      deps.revalidatePath(`/openings/${openingId}`, "layout");
    }
    return { ok: true, message: "Shortlisted — in TA Follow-up." };
  }

  if (isConvex()) {
    try {
      const result = await deps.convexMutation<{ success: boolean; stage: string; ownerTaId?: string }>(
        "ta/applications:moveStage",
        { actorId: user.id, applicationId, stage, reason: reason || undefined },
      );
      refreshed(openingId, deps);
      if (result.ownerTaId) return { ok: false, status: 409, message: `Already shortlisted by ${userName(result.ownerTaId)}.` };
    } catch (error) {
      return { ok: false, status: 409, message: safeErrorMessage(error, "That move could not be made.") };
    }
  } else {
    const unowned = stage === "ta_follow_up" && !app.ownerTaId;
    const result = repo.moveStage(applicationId, stage, user.id, reason || undefined);
    if (!result.ok) return { ok: false, status: 409, message: result.message };
    if (unowned) repo.shortlist(applicationId, user.id);
    deps.revalidatePath(`/openings/${openingId}`, "layout");
  }

  return { ok: true, message: `Moved to ${STAGE_LABEL[stage] ?? stage}.` };
}

/** The web bulk bar's same sequential, per-candidate permission behavior. */
export async function movePipelineCandidates(
  user: User,
  openingId: string,
  applicationIds: string[],
  stage: Stage,
  reason: string,
  deps: PipelineWriteDeps,
): Promise<{ ok: number; notOk: number; message: string }> {
  const results: PipelineMoveResult[] = [];
  for (const [index, applicationId] of applicationIds.entries()) {
    // A successful Convex write deliberately drops the primed store. Re-prime
    // before the next row, exactly as the web bulk action re-enters moveStage.
    if (index > 0) await deps.primeApplications?.();
    results.push(await movePipelineCandidate(user, openingId, applicationId, stage, reason, deps));
  }
  const moved = results.filter((result) => result.ok).length;
  const problems = [...new Set(results.filter((result) => !result.ok).map((result) => result.message))];
  const notOk = results.length - moved;
  const first = `${moved} moved to ${STAGE_LABEL[stage] ?? stage}.`;
  const message = notOk
    ? `${first} ${notOk} not: ${problems.slice(0, 2).join(" ")}${problems.length > 2 ? " …" : ""}`
    : first;
  return { ok: moved, notOk, message };
}
