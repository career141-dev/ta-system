import type { LinkLevel, LinkVaultEntry, ReviewRound } from "@/data/types";

/** The old workbook stops at four Ls and four sets. Keep the calculation here
 * data-driven so the report is only a view over facts the desk already saved. */
export const MASTER_SHEET_SLOTS = [1, 2, 3, 4] as const;

export interface MasterSheetSlot {
  at: number | null;
  count: number;
}

export interface MasterSheetRoundSlot extends MasterSheetSlot {
  shortlisted: number;
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
): MasterSheetRoundSlot {
  const matching = rounds
    .filter((round) => round.kind === kind && round.setNumber === n && round.dispatch === "sent")
    .sort((a, b) => a.sentAt - b.sentAt);
  const submitted = new Set<string>();
  const decisions = new Map<string, ReviewRound["decisions"][number]["outcome"]>();
  for (const round of matching) {
    for (const applicationId of round.applicationIds) submitted.add(applicationId);
    for (const decision of round.decisions) decisions.set(decision.applicationId, decision.outcome);
  }
  return {
    at: matching.length ? matching[0]!.sentAt : null,
    count: submitted.size,
    shortlisted: [...decisions.values()].filter((outcome) => outcome === "shortlisted").length,
  };
}

export function uniqueSubmitted(rounds: readonly Pick<ReviewRound, "kind" | "dispatch" | "applicationIds">[]): number {
  return new Set(
    rounds
      .filter((round) => round.kind === "director" && round.dispatch === "sent")
      .flatMap((round) => round.applicationIds),
  ).size;
}

