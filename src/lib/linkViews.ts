/**
 * How Excel Tables is cut (the desk, 29 Sep): by interest — All, Pending,
 * Interested, Not interested — and, separately, by L: a TA starts L1, L2, …
 * with the + beside Excel Tables in the sidebar, and each row belongs to the
 * L it was added under. iMark and add-ons are separate filters. Every cut is over
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
export function readLinkFilters(sp: { status?: string; view?: string; level?: string; addons?: string; imark?: string; by?: string; day?: string }) {
  const status = INTEREST_TABS.some((t) => t.key === sp.status) ? (sp.status ?? "") : sp.view === "shortlisted" ? "interested" : "";
  const level = sp.level === "none" ? NO_SHEET : Math.max(0, Math.floor(Number(sp.level)) || 0);
  // Who added the row (1 Oct): two TAs on one opening could not tell their
  // own headhunted profiles from each other's.
  const by = /^[\w-]{1,64}$/.test(sp.by ?? "") ? (sp.by as string) : "";
  return { status, level, imark: sp.imark === "1", addons: sp.addons === "1" || sp.view === "addons", by, day: readDay(sp.day) };
}

// ─── Sheets belong to one person (22 Oct) ───────────────────────────────────
//
// Each TA numbers their own L's, so "L1" across the desk was every TA's L1
// added together, under one person's date: the lead read L1 41 for Thushini's
// 40 and Hassan's 1. A sheet is now always one person's.

/** The "Not in a sheet" tab: a person's rows in no L. In the address, level=none. */
export const NO_SHEET = -1;

export const levelParam = (level: number) => (level === NO_SHEET ? "none" : String(level));

/**
 * Whose sheets the tabs show: the person chosen under Added by, or a TA's
 * own. A lead on Everyone gets none — there is no one person's L1 to show.
 */
export function sheetOwner(viewerId: string, viewerSeesEveryone: boolean, by: string): string {
  return by || (viewerSeesEveryone ? "" : viewerId);
}

/**
 * Whether a row is on the open sheet. Only the owner's rows are: a lead's
 * own L1 rows are not in a TA's L1, though the TA sees them under All.
 */
export function inSheet(row: { addedBy: string; level?: number | null }, level: number, owner: string): boolean {
  if (!level || !owner) return true;
  if (row.addedBy !== owner) return false;
  return level === NO_SHEET ? !(row.level && row.level > 0) : row.level === level;
}

// ─── When a link was added (22 Oct) ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Sri Lanka calendar day of a moment, as 2026-10-22. */
export function colomboDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" });
}

/** Today, yesterday, the last seven days or one date; anything else is any time. */
export function readDay(raw?: string): string {
  if (raw === "today" || raw === "yesterday" || raw === "week") return raw;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw ?? "") && !Number.isNaN(Date.parse(raw!)) ? raw! : "";
}

/** Whether a link added at `ts` falls in the chosen day, by the Sri Lanka calendar. */
export function inDay(ts: number, day: string, now = Date.now()): boolean {
  if (!day) return true;
  const d = colomboDay(ts);
  if (day === "today") return d === colomboDay(now);
  if (day === "yesterday") return d === colomboDay(now - DAY_MS);
  if (day === "week") return d >= colomboDay(now - 6 * DAY_MS) && d <= colomboDay(now);
  return d === day;
}

export function dayLabel(day: string): string {
  if (day === "today") return "Today";
  if (day === "yesterday") return "Yesterday";
  if (day === "week") return "Last 7 days";
  return day ? new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" }) : "Any time";
}
