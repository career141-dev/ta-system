import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { allows } from "@/lib/auth";
import { colomboDateValue } from "@/lib/calendar";
import type { StrategiesPayload } from "@/lib/mobile/strategyTypes";
import { countsOf, dayLabel, isTicked, proofsVisibleTo, strategyAcceptanceStatus, strategyTable } from "@/lib/strategyPlanner";
import { scopeStrategies } from "@/lib/visibility";

export function mobileStrategies(user: User, openingId: string): StrategiesPayload | null {
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  if (!opening || !client) return null;
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  if (!allows(user, "strategy.work", { openingId, assignment, onStrategy }) && !allows(user, "strategy.assign")) return null;

  const visible = scopeStrategies(repo.strategyAssignments(openingId), user);
  const rows = strategyTable(repo.strategies(true), visible)
    .filter((line) => line.row && (isTicked(line.row) || line.row.notApplicable))
    .map(({ strategy, row }) => {
      const value = row!;
      const submittedBy = value.submittedBy ? repo.user(value.submittedBy)?.name : null;
      const mine = value.doneBy.includes(user.id) || value.doneBy.length === 0;
      return {
        rowId: value.id,
        name: strategy.name,
        description: strategy.description,
        struck: value.notApplicable,
        doneBy: value.doneBy.map((id) => repo.user(id)?.name ?? "Someone"),
        doneByIds: value.doneBy,
        mine,
        acceptance: strategyAcceptanceStatus(value, user.id),
        assignedLabel: dayLabel(value.assignedAt),
        doneAtValue: colomboDateValue(value.doneAt),
        used: value.doneAt !== null,
        note: value.note ?? "",
        submittedLabel: value.submittedAt ? `Submitted${submittedBy ? ` by ${submittedBy}` : ""}, ${dayLabel(value.submittedAt)}` : null,
        proofs: proofsVisibleTo(value, user).map((proof) => ({
          id: proof.id,
          submitted: proof.submittedAt !== null,
          href: `/api/strategy-proof?row=${encodeURIComponent(value.id)}&proof=${encodeURIComponent(proof.id)}`,
        })),
      };
    });
  return {
    apiVersion: 1,
    context: { openingId, title: opening.title, clientName: client.name },
    counts: countsOf(visible),
    access: { canWork: allows(user, "strategy.work", { openingId, assignment, onStrategy }), canManageInPlanner: allows(user, "strategy.assign") },
    pendingCount: rows.filter((row) => !row.struck && row.mine && row.acceptance === "pending").length,
    rows,
  };
}
