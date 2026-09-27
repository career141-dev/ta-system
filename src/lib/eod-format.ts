import type { Id } from "@/data/types";

/**
 * The shape and column names of the end-of-day email, with no data access —
 * deliberately separate from `eod.ts` so a client component can import it
 * without dragging the server-side store into the browser bundle.
 */

export interface ShortlistRow {
  no: number;
  name: string;
  age: string;
  notice: string;
  notes: string[];
  currentCompany: string;
  currentDesignation: string;
  currentRemuneration: string;
  expectedRemuneration: string;
  applicationId: Id;
}

export interface EffortRow {
  date: string;
  assignee: string;
  /** What the day was: a full hunt, follow-up, or add-ons (plan 6.1). */
  hundredOrFollowUp: string;
  /** Profiles approached (100% / Add-on) or CVs (Follow-up) — see effortColumns. */
  lEffort: number | null;
  sets: number | null;
  da: number | null;
  scoop: number | null;
  l: number | null;
  post: number | null;
  addOns: number | null;
  backUp: number | null;
  /** The day's targets, typed by the TA; shown as a TARGET row when any is set. */
  targets?: Partial<Record<EffortKey, number | null>>;
}

/** The numeric L-sheet columns, which take a count and a target. */
export type EffortKey = "lEffort" | "sets" | "da" | "scoop" | "l" | "post" | "addOns" | "backUp";
export const EFFORT_NUMBERS: EffortKey[] = ["lEffort", "sets", "da", "scoop", "l", "post", "addOns", "backUp"];

/** What the day was. The desk's three kinds (21 Sep). */
export const OUTREACH_TYPES = ["100%", "Follow-up", "Add-on"] as const;

/** Table one, in the order the desk sends it. */
export const SHORTLIST_COLUMNS = [
  "NO",
  "NAME",
  // LOCATION was the candidate's home address — clutter to a Director, and
  // not ours to send round (testing review, 21 Sep).
  "AGE",
  "NOTICE",
  "NOTES",
  "CURRENT COMPANY",
  "CURRENT DESIGNATION",
  "CURRENT REMUNERATION",
  "EXPECTED REMUNERATION",
] as const;

/**
 * Table two's columns for a given kind of day. The fourth counts links
 * (profiles approached) on a full hunt or an add-on day, and CVs on a
 * follow-up day (plan 6.2).
 */
export function effortColumns(kind: string): { key: string; label: string }[] {
  return EFFORT_COLUMNS.map((c) =>
    c.key === "lEffort" ? { key: c.key, label: kind === "Follow-up" ? "NO. OF CVs" : "NO.OF L EFFORT" } : { ...c },
  );
}

/** Table two — the L-sheet. */
export const EFFORT_COLUMNS = [
  { key: "date", label: "DATE" },
  { key: "assignee", label: "ASSIGNEE" },
  { key: "hundredOrFollowUp", label: "100% / FOLLOW UP" },
  { key: "lEffort", label: "NO.OF L EFFORT" },
  { key: "sets", label: "SETS" },
  { key: "da", label: "DA (Direct Applicant)" },
  { key: "scoop", label: "SCOOP" },
  { key: "l", label: "L" },
  { key: "post", label: "POST" },
  { key: "addOns", label: "ADD-ONS" },
  { key: "backUp", label: "BACK-UP" },
] as const;

/**
 * The columns the TA types in; the records give SETS and DA (the desk,
 * 25 Sep — see effortRow in lib/eod). These start blank in the composer.
 * SCOOP left this list on 27 Sep: scoops mailed to the TA are counted, and
 * the TA adds the ones that came on WhatsApp.
 */
export const MANUAL_EFFORT: ReadonlySet<EffortKey> = new Set<EffortKey>(["lEffort", "l", "post", "addOns", "backUp"]);

/** The CVs the day brought, whatever the route — summed beside the set (the desk, 27 Sep). */
export const DAY_TOTAL_KEYS: EffortKey[] = ["da", "scoop", "l", "post", "addOns", "backUp"];

/** DA + SCOOP + L + POST + ADD-ONS + BACK-UP; a blank counts as none. */
export function dayTotal(values: Partial<Record<EffortKey, number | string | null | undefined>>): number {
  return DAY_TOTAL_KEYS.reduce((sum, k) => {
    const n = Number(values[k] ?? 0);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

/** The SETS cell as sent: "2 · 14 CVs" — the set, then the day's total. */
export function setsCell(sets: number | string | null | undefined, total: number): string {
  const cvs = `${total} ${total === 1 ? "CV" : "CVs"}`;
  return sets === null || sets === undefined || sets === "" ? cvs : `${sets} · ${cvs}`;
}

/** Who is copied on every end-of-day email, until it is changed on the People page. */
export const DEFAULT_EOD_CC = "azim@career141.com";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The end-of-day email as it is sent: the same greeting, the same two tables
 * and the same sign-off as the composer on screen. Inline styles only, because
 * that is all a mail client keeps.
 */
export function eodEmailHtml(input: {
  rows: ShortlistRow[];
  effort: EffortRow;
  senderName: string;
  senderTitle?: string;
  /** A line under the tables when some CVs could not be attached. */
  attachmentNote?: string | null;
}): string {
  const th = 'style="border:1px solid #cfd6d1;background:#eef2ef;padding:6px 8px;text-align:left;font-size:11px;font-weight:600;white-space:nowrap"';
  const td = 'style="border:1px solid #cfd6d1;padding:6px 8px;vertical-align:top;font-size:12px"';
  const table = (head: string, body: string) =>
    `<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;margin:12px 0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  const shortlist = table(
    SHORTLIST_COLUMNS.map((h) => `<th ${th}>${esc(h)}</th>`).join(""),
    input.rows
      .map(
        (r) =>
          `<tr><td ${td}>${r.no}</td><td ${td}><b>${esc(r.name)}</b></td><td ${td}>${esc(r.age)}</td><td ${td}>${esc(r.notice)}</td><td ${td}>${r.notes.map(esc).join("<br>")}</td><td ${td}>${esc(r.currentCompany)}</td><td ${td}>${esc(r.currentDesignation)}</td><td ${td}>${esc(r.currentRemuneration)}</td><td ${td}>${esc(r.expectedRemuneration)}</td></tr>`,
      )
      .join(""),
  );

  const cols = effortColumns(input.effort.hundredOrFollowUp);
  const targets = input.effort.targets ?? {};
  const hasTargets = EFFORT_NUMBERS.some((k) => targets[k] != null);
  const effort = table(
    cols.map((c) => `<th ${th}>${esc(c.label)}</th>`).join(""),
    `<tr>${cols.map((c) => {
      if (c.key === "sets") return `<td ${td.replace('"', '"white-space:nowrap;')}>${esc(setsCell(input.effort.sets, dayTotal(input.effort)))}</td>`;
      const v = input.effort[c.key as keyof EffortRow];
      return `<td ${td}>${v === null || v === undefined || typeof v === "object" ? "" : esc(v)}</td>`;
    }).join("")}</tr>` +
      (hasTargets
        ? `<tr>${cols.map((c, i) => {
            const t = targets[c.key as EffortKey];
            return `<td ${td}>${i === 1 ? "<i>Target</i>" : t == null ? "" : esc(t)}</td>`;
          }).join("")}</tr>`
        : ""),
  );

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.7;color:#171c18">
<p>Dear Sir,<br><br>Please find the attached Shortlisted CV for the above-mentioned position</p>
${shortlist}
${effort}
${input.attachmentNote ? `<p style="color:#6b736d">${esc(input.attachmentNote)}</p>` : ""}
<p>Thank You<br>Best Regards,<br><br>${esc(input.senderName)}<br>${esc(input.senderTitle ?? "Executive - Talent Acquisition")}</p>
</div>`;
}
