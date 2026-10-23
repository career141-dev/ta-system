import type { Application, LinkLevel, LinkVaultEntry, Opening, ReviewRound, User } from "@/data/types";
import { isTa } from "@/lib/auth";

/** The old workbook stops at four Ls and four sets. Keep the calculation here
 * data-driven so the report is only a view over facts the desk already saved. */
export const MASTER_SHEET_SLOTS = [1, 2, 3, 4] as const;

/** Current recruiters, then former contributors; keep unattributed work visible. */
export function masterSheetActorIds(
  opening: Pick<Opening, "assignedTaIds">,
  applications: readonly Pick<Application, "ownerTaId">[],
  links: readonly Pick<LinkVaultEntry, "addedBy">[],
  users: readonly Pick<User, "id" | "role">[],
): (string | null)[] {
  const known = new Map(users.map((user) => [user.id, user]));
  const owners = new Set(applications.map((application) => application.ownerTaId).filter((id): id is string => Boolean(id)));
  const actorIds = new Set([
    ...opening.assignedTaIds,
    ...owners,
    ...links.map((link) => link.addedBy).filter((id) => isTa(known.get(id))),
  ].filter((id) => known.has(id)));
  const unassigned = actorIds.size === 0 ||
    applications.some((application) => !application.ownerTaId || !actorIds.has(application.ownerTaId)) ||
    links.some((link) => !actorIds.has(link.addedBy));
  return [...actorIds, ...(unassigned ? [null] : [])];
}

export interface MasterSheetSlot {
  at: number | null;
  count: number;
}

export interface MasterSheetRoundSlot extends MasterSheetSlot {
  shortlisted: number;
  dateUnknown?: number;
}

export type MasterSheetPositionStatus = "active" | "hold" | "lost" | "filled";

/** One status drives both vocabularies and the closed date. A closed date on
 * an active or held role is stale data; a lost or filled role gets the date a
 * person supplied, then its existing date, then today. */
export function masterSheetStatusFields(
  positionStatus: MasterSheetPositionStatus,
  typedClosedAt: number | null,
  existingClosedAt: number | null,
  now = Date.now(),
): {
  status: "open" | "on_hold" | "closed" | "filled";
  backendStatus: "active" | "on_hold" | "cancelled" | "filled";
  closedAt: number | null;
} {
  if (positionStatus === "active") return { status: "open", backendStatus: "active", closedAt: null };
  if (positionStatus === "hold") return { status: "on_hold", backendStatus: "on_hold", closedAt: null };
  const closedAt = typedClosedAt ?? existingClosedAt ?? now;
  return positionStatus === "filled"
    ? { status: "filled", backendStatus: "filled", closedAt }
    : { status: "closed", backendStatus: "cancelled", closedAt };
}

export function levelSlot(
  levels: readonly Pick<LinkLevel, "n" | "at">[],
  rows: readonly Pick<LinkVaultEntry, "level">[],
  n: number,
): MasterSheetSlot {
  const dates = levels.filter((level) => level.n === n).map((level) => level.at);
  return {
    at: dates.length ? Math.min(...dates) : null,
    count: rows.filter((row) => row.level === n).length,
  };
}

/**
 * A corrected/resubmitted round can mention the same person again. The newest
 * decision wins and each application is counted once, just as the screen does.
 */
export function roundSlot(
  rounds: readonly Pick<ReviewRound, "kind" | "setNumber" | "sentAt" | "dispatch" | "applicationIds" | "decisions">[],
  kind: ReviewRound["kind"],
  n: number,
  since?: number,
): MasterSheetRoundSlot {
  const matching = rounds
    .filter((round) => round.kind === kind && round.setNumber === n && round.dispatch === "sent")
    .sort((a, b) => a.sentAt - b.sentAt);
  const submitted = new Set<string>();
  const decisions = new Map<string, ReviewRound["decisions"][number]>();
  for (const round of matching) {
    if (since === undefined || round.sentAt >= since) {
      for (const applicationId of round.applicationIds) submitted.add(applicationId);
    }
    for (const decision of round.decisions) decisions.set(decision.applicationId, decision);
  }
  const shortlisted = [...decisions.values()].filter((decision) => decision.outcome === "shortlisted");
  return {
    at: (since === undefined ? matching : matching.filter((round) => round.sentAt >= since))[0]?.sentAt ?? null,
    count: submitted.size,
    shortlisted: shortlisted.filter((decision) => since === undefined || (decision.decidedAt !== undefined && decision.decidedAt >= since)).length,
    ...(since === undefined ? {} : { dateUnknown: shortlisted.filter((decision) => decision.decidedAt === undefined).length }),
  };
}

export function uniqueSubmitted(rounds: readonly Pick<ReviewRound, "kind" | "dispatch" | "applicationIds" | "sentAt">[], since?: number): number {
  return new Set(
    rounds
      .filter((round) => round.kind === "director" && round.dispatch === "sent" && (since === undefined || round.sentAt >= since))
      .flatMap((round) => round.applicationIds),
  ).size;
}

/** Candidate work belongs to the TA who claimed it. Unclaimed intake is still
 * visible in the opening's workflow, but is not credited to an individual TA
 * until somebody takes responsibility for it. */
export function masterSheetApplicationsForUser(
  applications: readonly Application[],
  userId: string,
): Application[] {
  return applications.filter((application) => application.ownerTaId === userId);
}

/** Keep the shared email round, but only the candidates belonging to this TA.
 * This also handles a lead sending one combined email for several recruiters:
 * every personal sheet receives its own candidates from that common round. */
export function masterSheetRoundsForApplications(
  rounds: readonly ReviewRound[],
  applicationIds: ReadonlySet<string>,
): ReviewRound[] {
  return rounds.flatMap((round) => {
    const included = round.applicationIds.filter((id) => applicationIds.has(id));
    if (included.length === 0) return [];
    return [{
      ...round,
      applicationIds: included,
      decisions: round.decisions.filter((decision) => applicationIds.has(decision.applicationId)),
    }];
  });
}

