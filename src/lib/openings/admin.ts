import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { ASSIGNMENT_LABEL, type AssignmentRole, type PriorityTier, type User } from "@/data/types";
import { isTa } from "@/lib/auth";
import { safeErrorMessage } from "@/lib/userError";
import type { WorkLocation } from "@/lib/workLocations";
import type { OpeningWriteDeps } from "@/lib/openings/writes";

/**
 * The Overview's admin actions — access requests, the team, the details form —
 * shared by the web's server actions (src/app/actions.ts) and the mobile API,
 * so both refuse the same things with the same words (22 Oct). The capability
 * check (`decideOn`) stays with the caller, as `authorize()` does on the web.
 */

export type Outcome = { ok: true; tone: "ok" | "note"; message: string } | { ok: false; message: string };

/** A TA asks the lead to be added to an opening. Nothing is granted here. */
export async function requestAccess(
  user: User,
  openingId: string,
  reason: string,
  deps: Pick<OpeningWriteDeps, "convexMutation" | "revalidatePath">,
): Promise<Outcome> {
  if (!isTa(user)) return { ok: false, message: "Only a TA can request access to an opening." };
  if (!openingId) return { ok: false, message: "Select an opening first." };
  if (!isConvex()) return { ok: false, message: "Access requests need the connected system." };
  let result: { ok: boolean; alreadyAssigned?: boolean; alreadyPending?: boolean } | null = null;
  try {
    result = await deps.convexMutation<{ ok: boolean; alreadyAssigned?: boolean; alreadyPending?: boolean }>("ta/openingAccess:request", {
      actorId: user.id,
      openingId,
      reason: reason || undefined,
    });
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error, "The access request could not be sent.") };
  }
  if (!result) return { ok: false, message: "The access request could not be sent." };
  deps.revalidatePath("/openings");
  deps.revalidatePath("/api/notifications");
  if (result.alreadyAssigned) return { ok: true, tone: "note", message: "You already have access to that opening." };
  if (result.alreadyPending) return { ok: true, tone: "note", message: "Your access request is already waiting for approval." };
  return { ok: true, tone: "ok", message: "Access request sent to the TA Lead." };
}

/** Approving and assigning happen in one backend transaction; the backend checks the approver. */
export async function decideAccess(
  user: User,
  requestId: string,
  decision: string,
  reason: string,
  deps: Pick<OpeningWriteDeps, "convexMutation" | "revalidatePath" | "markTablesStale">,
): Promise<Outcome> {
  if (decision !== "approve" && decision !== "reject") return { ok: false, message: "Choose Approve or Reject." };
  const approve = decision === "approve";
  if (!requestId) return { ok: false, message: "That access request no longer exists." };
  if (!isConvex()) return { ok: false, message: "Access requests need the connected system." };
  try {
    await deps.convexMutation("ta/openingAccess:decide", { actorId: user.id, requestId, approve, reason: reason || undefined });
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error, "The access request could not be decided.") };
  }
  deps.markTablesStale();
  deps.revalidatePath("/openings", "layout");
  deps.revalidatePath("/api/notifications");
  return { ok: true, tone: "ok", message: approve ? "Access approved. The TA was added as a supporting recruiter." : "Access request rejected." };
}

export const ASSIGNMENT_ROLES: AssignmentRole[] = ["primary_recruiter", "supporting_recruiter", "director", "client_contact"];

/**
 * Who is on the opening, and as what. One person, one seat (the last row wins),
 * and a team with nobody recruiting is refused. Newly seated recruiters get a
 * bell notification. Called after `opening.manage` has been decided.
 */
export async function writeOpeningTeam(
  user: User,
  openingId: string,
  rows: { userId: string; role: string }[],
  deps: Pick<OpeningWriteDeps, "convexMutation" | "revalidatePath">,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const valid = rows.filter((r) => r.userId && r.role).map((r) => ({ userId: r.userId, role: r.role as AssignmentRole }));
  const unique = [...new Map(valid.map((r) => [r.userId, r])).values()];
  const recruiters = unique.filter((r) => r.role === "primary_recruiter" || r.role === "supporting_recruiter");
  if (recruiters.length === 0) return { ok: false, message: "A team needs at least one recruiter on it. Nothing was changed." };

  // Captured before the write, since after it the old team is gone.
  const previousTeam = new Set(repo.assignments(openingId).map((a) => a.userId));
  const newlyAssigned = recruiters.filter((r) => r.userId !== user.id && !previousTeam.has(r.userId));

  repo.setAssignments(openingId, unique, user.id);
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  deps.revalidatePath("/alerts");
  deps.revalidatePath("/api/notifications");

  if (newlyAssigned.length) {
    const title = repo.opening(openingId)?.title ?? "an opening";
    await Promise.all(
      newlyAssigned.map((r) =>
        deps
          .convexMutation("ta/notifications:create", {
            userId: r.userId,
            type: "opening_assigned",
            title: "You were assigned to an opening",
            body: `${user.name} added you to ${title} as ${ASSIGNMENT_LABEL[r.role]}.`,
            jobId: openingId,
          })
          .catch((e) => console.error("[notifications] opening_assigned failed:", e)),
      ),
    );
  }
  return { ok: true };
}

export interface OpeningDetailsInput {
  title: string;
  /** As typed: commas and currency signs go, a minus sign does not. */
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  packageNotes: string;
  /** Comma-separated, as the form sends them. Ignored when the opening has work locations. Callers default
   *  a missing currency to "LKR", priority to "P3" and headcount to "1", as the web form did. */
  locations: string;
  targetNationalities: string;
  headcount: string;
  priorityTier: string;
}

const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
// Commas and currency go; a minus sign does not. Stripping it turned "-5000"
// into 5000 (audit finding 40). A negative or zero amount is no amount.
const num = (v: string) => {
  const n = Number(v.replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The details form, checked in the web form's order and words; then saved. */
export function writeOpeningDetails(
  openingId: string,
  input: OpeningDetailsInput,
  workLocations: WorkLocation[] | undefined,
  deps: Pick<OpeningWriteDeps, "revalidatePath">,
): { ok: true } | { ok: false; message: string } {
  const title = input.title.trim();
  if (!title) return { ok: false, message: "An opening needs a title." };
  const salaryMin = num(input.salaryMin);
  const salaryMax = num(input.salaryMax);
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) return { ok: false, message: "The salary 'from' is higher than the 'to'." };
  const tier = input.priorityTier;
  if (!["P1", "P2", "P3", "P4", "P5"].includes(tier)) return { ok: false, message: "Pick a priority from the list." };
  const currency = input.salaryCurrency;
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, message: "Pick a currency from the list." };

  const live = workLocations?.filter((l) => !l.archived);
  repo.updateOpening(openingId, {
    ...(workLocations ? { workLocations } : {}),
    title,
    salaryMin,
    salaryMax,
    salaryCurrency: currency,
    packageNotes: input.packageNotes.trim(),
    locations: live ? live.map((l) => l.name) : list(input.locations),
    targetNationalities: list(input.targetNationalities),
    headcount: live ? live.reduce((n, l) => n + l.vacancies, 0) : Math.max(1, Number(input.headcount || 1) || 1),
    priorityTier: tier as PriorityTier,
  });
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  return { ok: true };
}
