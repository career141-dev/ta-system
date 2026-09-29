import { colomboDay } from "../../convex/lib/sets";

/**
 * How Excel Tables is cut (the desk, 29 Sep): by interest — All, Pending,
 * Interested, Not interested — and, separately, by the day the TA added the
 * row (L1 is the first day links went in for this opening, L2 the next, …).
 * Add-ons stay a filter of their own. Every cut is over the same rows: a
 * person changes tab, they are never copied.
 */
export const INTEREST_TABS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "interested", label: "Interested" },
  { key: "not_interested", label: "Not interested" },
] as const;

export type Interest = "pending" | "interested" | "not_interested";

const CLOSED = new Set(["rejected", "dropped_out"]);

/**
 * Where a row stands. The pipeline decides once the person is on it, so the
 * two can never disagree: active there is Interested, rejected or dropped out
 * is Not interested — whichever screen the change was made on. Off the
 * pipeline, a Declined outcome is Not interested and anything else Pending.
 * (New rows arrive Shortlisted, so the outcome alone cannot mean Interested.)
 */
export function interestOf(row: { outcome: string }, app: { stage: string } | null | undefined): Interest {
  if (app) return CLOSED.has(app.stage) ? "not_interested" : "interested";
  return row.outcome === "declined" ? "not_interested" : "pending";
}

export const INTEREST_LABEL: Record<Interest, string> = {
  pending: "Pending",
  interested: "Interested",
  not_interested: "Not interested",
};

/** The table's working days, oldest first: index 0 is L1. */
export function linkDays(rows: { createdAt: number }[]): number[] {
  return [...new Set(rows.map((r) => colomboDay(r.createdAt)))].sort((a, b) => a - b);
}

/** A row's L number on this opening, from the day it was added. */
export function dayOf(row: { createdAt: number }, days: number[]): number {
  return days.indexOf(colomboDay(row.createdAt)) + 1;
}

/** "L2 · 27 Sep" — the number the desk uses, with the day it stands for. */
export function dayLabel(n: number, day: number): string {
  return `L${n} · ${new Date(day).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" })}`;
}

/** Old links (?view=shortlisted / ?view=addons) keep working. */
export function readLinkFilters(sp: { status?: string; view?: string; day?: string; addons?: string }) {
  const status = INTEREST_TABS.some((t) => t.key === sp.status) ? (sp.status ?? "") : sp.view === "shortlisted" ? "interested" : "";
  const day = Math.max(0, Math.floor(Number(sp.day)) || 0);
  return { status, day, addons: sp.addons === "1" || sp.view === "addons" };
}
