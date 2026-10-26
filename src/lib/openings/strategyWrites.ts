import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { can } from "@/lib/auth";
import { colomboDayFromValue, colomboDayStart } from "@/lib/calendar";
import type { OpeningWriteDeps } from "@/lib/openings/writes";
import { isTicked } from "@/lib/strategyPlanner";

export type StrategyWriteOutcome = { ok: true; message: string; tone?: "ok" | "note" } | { ok: false; status: 400 | 403 | 404; message: string };
export interface StrategyWriteDeps extends Pick<OpeningWriteDeps, "convexMutation" | "markTablesStale"> {
  notify?: (path: string) => void;
}

const lastBell = new Map<string, number>();
export function strategyBellDue(key: string, ms = 30_000): boolean {
  const now = Date.now();
  if (now - (lastBell.get(key) ?? 0) < ms) return false;
  lastBell.set(key, now);
  return true;
}

function decide(user: User, openingId: string): StrategyWriteOutcome | null {
  if (!openingId || !repo.opening(openingId)) return { ok: false, status: 404, message: "That opening no longer exists." };
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  const decision = can(user, "strategy.work", { openingId, assignment, ownerTaId: null, onStrategy });
  return decision.ok ? null : { ok: false, status: 403, message: decision.message };
}

export function acceptStrategies(user: User, openingId: string, deps: StrategyWriteDeps): StrategyWriteOutcome {
  const refused = decide(user, openingId);
  if (refused) return refused;
  const accepted = repo.acceptStrategyAssignments({ openingId, taId: user.id });
  deps.markTablesStale();
  if (accepted === 0) return { ok: true, tone: "note", message: "There are no new strategy assignments to accept." };
  return { ok: true, message: `Accepted ${accepted} ${accepted === 1 ? "strategy" : "strategies"}. You can start working on ${accepted === 1 ? "it" : "them"} now.` };
}

export async function submitStrategies(
  user: User,
  openingId: string,
  input: { rowId: string; used: boolean; date: string; note: string }[],
  deps: StrategyWriteDeps,
): Promise<StrategyWriteOutcome> {
  const refused = decide(user, openingId);
  if (refused) return refused;
  if (input.length === 0) return { ok: false, status: 400, message: "There is nothing to submit." };
  const today = colomboDayStart(Date.now());
  const rows: { rowId: string; doneAt: number | null; note: string | null }[] = [];
  for (const item of input) {
    const row = repo.strategyAssignment(item.rowId);
    if (!row || row.openingId !== openingId || row.notApplicable) continue;
    const onIt = row.doneBy.includes(user.id);
    if (!onIt && !isTicked(row)) continue;
    const typed = item.date.trim();
    const day = colomboDayFromValue(typed);
    if (item.used && typed && day === null) return { ok: false, status: 400, message: `That is not a date (${row.strategyName}).` };
    const text = item.note.trim();
    if (text.length > 500) return { ok: false, status: 400, message: `Keep the note under 500 characters (${row.strategyName}).` };
    if (!onIt && !item.used && !text) continue;
    rows.push({ rowId: row.id, doneAt: item.used ? day ?? today : null, note: text || null });
  }
  if (rows.length === 0) return { ok: false, status: 400, message: "None of those strategies are yours to update." };
  const taken = repo.submitStrategyRows({ openingId, taId: user.id, rows });
  if (taken === 0) return { ok: false, status: 400, message: "Accept your new strategy assignments before submitting an update." };
  deps.markTablesStale();
  const opening = repo.opening(openingId)!;
  if (isConvex() && opening.taLeadId && opening.taLeadId !== user.id && strategyBellDue(`submit:${user.id}:${openingId}`, 5 * 60_000)) {
    await deps.convexMutation("ta/notifications:create", {
      userId: opening.taLeadId, type: "strategy_assigned", title: "A TA submitted strategies",
      body: `${user.name} submitted their strategies on ${opening.title}.`, jobId: openingId,
    }).catch((error) => console.error("[notifications] strategy submit failed:", error));
    deps.notify?.("/api/notifications");
  }
  return { ok: true, message: `Submitted ${taken} ${taken === 1 ? "strategy" : "strategies"}. Your TA Lead can now see ${taken === 1 ? "it" : "them"}.` };
}

export async function removeStrategyPicture(user: User, rowId: string, proofId: string, deps: StrategyWriteDeps, expectedOpeningId?: string): Promise<StrategyWriteOutcome> {
  const row = repo.strategyAssignment(rowId);
  if (!row || expectedOpeningId && row.openingId !== expectedOpeningId) return { ok: false, status: 404, message: "That strategy is no longer on this job's table." };
  const refused = decide(user, row.openingId);
  if (refused) return refused;
  const proof = row.proofs.find((value) => value.id === proofId);
  if (!proof) return { ok: false, status: 400, message: "That picture is already gone." };
  if (proof.addedBy !== user.id) return { ok: false, status: 403, message: "Only the person who attached a picture can remove it." };
  const gone = repo.removeStrategyProof(row.id, proofId);
  if (gone && isConvex()) await deps.convexMutation("ta/strategies:proofDelete", { storageId: gone }).catch(() => {});
  deps.markTablesStale();
  return { ok: true, message: "Picture removed." };
}
