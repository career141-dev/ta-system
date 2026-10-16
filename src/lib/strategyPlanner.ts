import type { Opening, Strategy, StrategyAssignment, StrategyProof, User } from "@/data/types";
import { COLOMBO_OFFSET_MS, colomboDateValue } from "@/lib/calendar";
import { isTa } from "@/lib/auth";

/**
 * The Strategy Planner's view of the desk (8 Oct): every job still being worked,
 * grouped under the TA on it, and each job's table of strategies. Pure, so it
 * is tested; the pages only draw it.
 */

export interface StrategyCounts {
  /** Rows with a TA put on them and not struck through. */
  assigned: number;
  /** Of those, how many the TA has submitted as used (a Date Done). */
  done: number;
  /** Rows struck through for the job. */
  notApplicable: number;
}

/**
 * Ticked for the job: the lead chose it, so the TAs on the job see it (9 Oct).
 * A row from before the tick box has no answer and counts as ticked once a TA
 * is on it, which is how those rows reached their TA until now.
 */
export function isTicked(r: Pick<StrategyAssignment, "selected" | "doneBy">): boolean {
  return r.selected ?? r.doneBy.length > 0;
}

/** A row counts toward progress when it is ticked or has a TA on it, unless it is struck through. */
export function countsOf(rows: StrategyAssignment[]): StrategyCounts {
  const c: StrategyCounts = { assigned: 0, done: 0, notApplicable: 0 };
  for (const r of rows) {
    if (r.notApplicable) {
      c.notApplicable++;
      continue;
    }
    if (!isTicked(r) && r.doneBy.length === 0) continue;
    c.assigned++;
    if (r.doneAt !== null) c.done++;
  }
  return c;
}

/** Jobs a lead plans: open jobs. On hold, closed, and filled ones are not in the strategy sheet. */
export const isPlannable = (o: Opening) => o.status === "open";

export interface PlannerJob {
  opening: Opening;
  counts: StrategyCounts;
}

export interface PlannerGroup {
  ta: User;
  jobs: PlannerJob[];
  counts: StrategyCounts;
}

/**
 * One group per active TA who is on at least one plannable job, TAs and jobs in
 * name order, plus the plannable jobs that have no TA yet. A TA on several jobs
 * appears once, with each job under them; a job with two TAs appears under both,
 * each time counting only the rows that TA is on.
 */
export function plannerByTa(
  openings: Opening[],
  users: User[],
  rows: StrategyAssignment[],
): { groups: PlannerGroup[]; unstaffed: Opening[] } {
  const live = openings.filter(isPlannable);
  const tas = users.filter((u) => isTa(u) && u.isActive);
  const groups: PlannerGroup[] = [];
  for (const ta of tas) {
    const mine = live.filter((o) => o.assignedTaIds.includes(ta.id));
    if (mine.length === 0) continue;
    const onJob = (o: Opening) => rows.filter((r) => r.openingId === o.id && r.doneBy.includes(ta.id));
    const jobs = mine
      .map((opening) => ({ opening, counts: countsOf(onJob(opening)) }))
      .sort((a, b) => a.opening.title.localeCompare(b.opening.title));
    groups.push({ ta, jobs, counts: countsOf(mine.flatMap(onJob)) });
  }
  groups.sort((a, b) => a.ta.name.localeCompare(b.ta.name));
  const unstaffed = live
    .filter((o) => !o.assignedTaIds.some((id) => tas.some((t) => t.id === id)))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { groups, unstaffed };
}

export interface PlannerJobLine {
  opening: Opening;
  /** The active TAs on the job, in name order. */
  tas: User[];
  counts: StrategyCounts;
}

/**
 * The planner as one table of jobs (9 Oct): every job still being worked, by
 * client and then title, with its TAs and how far its strategies have got. A job
 * with no TA is listed too; its strategies can be ticked before anyone is on it.
 */
export function plannerJobs(openings: Opening[], users: User[], rows: StrategyAssignment[], clientName: (id: string) => string): PlannerJobLine[] {
  const tas = users.filter((u) => isTa(u) && u.isActive);
  return openings
    .filter(isPlannable)
    .map((opening) => ({
      opening,
      tas: tas.filter((t) => opening.assignedTaIds.includes(t.id)).sort((a, b) => a.name.localeCompare(b.name)),
      counts: countsOf(rows.filter((r) => r.openingId === opening.id)),
    }))
    .sort((a, b) => clientName(a.opening.clientId).localeCompare(clientName(b.opening.clientId)) || a.opening.title.localeCompare(b.opening.title));
}

/** One line of a job's table: a strategy, and the row the lead has made for it, if any. */
export interface StrategyTableLine {
  strategy: Pick<Strategy, "id" | "name" | "description" | "group" | "active">;
  row: StrategyAssignment | null;
}

/**
 * The job's table: every strategy still on the list, in the list's order, each
 * with its row; then any retired strategy that already has a row, so what was
 * done under it never disappears. A row whose strategy was deleted outright
 * (it cannot be from the app, but a restore could) is still shown, by its name.
 */
export function strategyTable(strategies: Strategy[], rows: StrategyAssignment[]): StrategyTableLine[] {
  const rowOf = new Map(rows.map((r) => [r.strategyId, r]));
  const lines: StrategyTableLine[] = strategies
    .filter((s) => s.active || rowOf.has(s.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((s) => ({ strategy: s, row: rowOf.get(s.id) ?? null }));
  const listed = new Set(strategies.map((s) => s.id));
  for (const r of rows) {
    if (listed.has(r.strategyId)) continue;
    lines.push({
      strategy: { id: r.strategyId, name: r.strategyName, description: null, group: null, active: false },
      row: r,
    });
  }
  return lines;
}

/** A line of the lead's table, ready to draw (9 Oct). The shape is StrategyLeadTable's LeadStrategyLine. */
export function leadLine({ strategy, row }: StrategyTableLine, nameOf: (id: string | null) => string) {
  return {
    strategyId: strategy.id,
    name: strategy.name,
    description: strategy.description,
    active: strategy.active,
    rowId: row?.id ?? null,
    ticked: row ? isTicked(row) : false,
    struck: !!row?.notApplicable,
    doneBy: (row?.doneBy ?? []).map((id) => ({ id, name: nameOf(id) })),
    assignedValue: colomboDateValue(row?.assignedAt ?? null),
    doneValue: colomboDateValue(row?.doneAt ?? null),
    note: row?.note ?? "",
    submittedLabel: row?.submittedAt ? `Submitted by ${nameOf(row.submittedBy)}, ${dayLabel(row.submittedAt)}` : null,
    proofIds: row ? proofsForLead(row).map((p) => p.id) : [],
  };
}

/**
 * What a lead may read of a TA's row: the proofs the TA has submitted. Dates and
 * the note are only ever written at submit, so they are already the submitted
 * ones; a proof can be attached before, and stays the TA's own until then.
 */
export function proofsForLead(row: StrategyAssignment): StrategyProof[] {
  return row.proofs.filter((p) => p.submittedAt !== null);
}

/** The proofs one person may see on a row: a lead the submitted ones, a TA the ones they attached themselves. */
export function proofsVisibleTo(row: StrategyAssignment, user: Pick<User, "id" | "role">): StrategyProof[] {
  if (isTa(user)) return row.proofs.filter((p) => p.addedBy === user.id);
  if (user.role === "admin" || user.role === "director" || user.role === "ta_lead" || user.role === "ops") return proofsForLead(row);
  return [];
}

/** The list grouped under its headings, in the list's own order; no heading last. */
export function groupStrategies<T extends { group: string | null }>(items: T[]): { heading: string | null; items: T[] }[] {
  const order: (string | null)[] = [];
  const by = new Map<string | null, T[]>();
  for (const s of items) {
    const g = s.group?.trim() || null;
    if (!by.has(g)) {
      by.set(g, []);
      order.push(g);
    }
    by.get(g)!.push(s);
  }
  const named = order.filter((g): g is string => g !== null);
  const rest = order.includes(null) ? [null] : [];
  return [...named, ...rest].map((heading) => ({ heading, items: by.get(heading)! }));
}

/**
 * The desk's own strategies, in the order the owner gave them (8 Oct; the last
 * four added 9 Oct). Loaded by ta/strategies:seedCatalogue and the local sample data.
 */
export const DESK_STRATEGIES: string[] = [
  "LinkedIn Search",
  "Recruiter Search & POST",
  "Direct Headhunt",
  "SCOOP",
  "InMail",
  "Designation wise search",
  "Previous Post screening",
  "L search Extraction",
  "Company Extraction",
  "Referral Extraction",
  "Repository",
  "Smart Ad",
  "AI Search",
  "Identify shortlisted candidates and do company",
  "Email Campaign",
  "Aura",
  "ChatGPT",
  "Gemini",
  "Linked Post",
];

/** A Colombo day for the table: "8 Oct 2026", or a dash. (Not dateAt, which reads in the server's zone.) */
export function dayLabel(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  return new Date(ts + COLOMBO_OFFSET_MS).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
