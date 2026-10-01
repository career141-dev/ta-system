/**
 * How Excel Tables is cut (the desk, 29 Sep): by interest — All, Pending,
 * Interested, Not interested — and, separately, by L: a TA starts L1, L2, …
 * with the + beside Excel Tables in the sidebar, and each row belongs to the
 * L it was added under. Add-ons stay a filter of their own. Every cut is over
 * the same rows: a person changes tab, they are never copied.
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
  if (app && CLOSED.has(app.stage)) return "not_interested";
  // Matched to the opening by the system — Database matches, New CVs, the
  // AI's own shortlist — is not a TA's Interested (1 Oct). It read as
  // Interested, so the Interested button was hidden and the TA had no way to
  // take them on from the row. Pending until a TA does.
  if (app && !SYSTEM_ONLY.has(app.stage)) return "interested";
  return row.outcome === "declined" ? "not_interested" : "pending";
}

const SYSTEM_ONLY = new Set(["matched", "new_cv", "ai_follow_up"]);

export const INTEREST_LABEL: Record<Interest, string> = {
  pending: "Pending",
  interested: "Interested",
  not_interested: "Not interested",
};

/** "L2 · Banks" when the TA named it, "L2 · 29 Sept" when not. */
export function levelLabel(l: { n: number; at: number; name?: string }): string {
  return `L${l.n} · ${l.name || new Date(l.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" })}`;
}

/** Old links (?view=shortlisted / ?view=addons) keep working. */
export function readLinkFilters(sp: { status?: string; view?: string; level?: string; addons?: string }) {
  const status = INTEREST_TABS.some((t) => t.key === sp.status) ? (sp.status ?? "") : sp.view === "shortlisted" ? "interested" : "";
  const level = Math.max(0, Math.floor(Number(sp.level)) || 0);
  return { status, level, addons: sp.addons === "1" || sp.view === "addons" };
}
