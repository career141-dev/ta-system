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
  /** Profiles scouted (100% / Add-on) or CVs (Follow-up) — see effortColumns. */
  lEffort: number | null;
  sets: string | number | null;
  da: number | null;
  scoop: number | null;
  l: number | null;
  post: number | null;
  addOns: number | null;
  backUp: number | null;
  /** The day's targets, typed by the TA; shown as a TARGET row when any is set. */
  targets?: Partial<Record<EffortKey, number | string | null>>;
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
 * (profiles scouted) on a full hunt or an add-on day, and CVs on a
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
 * The columns the TA types in; the records give the rest. None since the
 * desk's breakdown (28 Sep): BACK-UP is counted from the Backup tag like the
 * others. Kept so a column can go back to typed without touching the sheet.
 * The TA can still correct any figure before sending.
 */
export const MANUAL_EFFORT: ReadonlySet<EffortKey> = new Set<EffortKey>();

/** The columns each of the day's CVs is counted in — exactly one of them. */
export const CV_COLUMNS: EffortKey[] = ["da", "scoop", "l", "post", "addOns", "backUp"];

/**
 * The CVs the day brought, beside the set (the desk, 28 Sep): the columns
 * added up. That used to count an add-on twice — it was also a DA or an L —
 * so the total was taken from the records instead. Now each CV sits in one
 * column (lib/eod effortBucket: backup, then add-on, then where it came
 * from), so the sum is the day, and a figure the TA corrects — a WhatsApp
 * scoop the system never saw — carries straight into the total.
 */
export function dayTotal(values: Partial<Record<EffortKey, number | string | null | undefined>>): number {
  return CV_COLUMNS.reduce((sum, k) => {
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

/**
 * Who the Director's end-of-day email goes to, as the desk set it on 29 Sep:
 * the job-orders box, copying the leads and ops. The TA adds more on the
 * composer (extra To, extra Cc); these are always on it. The shortlist inbox
 * that watches for the reply is added on top by the sender, not listed here.
 */
export const EOD_TO = "joborders@career141.com";
export const EOD_CC_DEFAULTS = [
  "shamra@career141.com",
  "asma@career141.com",
  "opsteam@career141.com",
  "cv@career141.com",
] as const;

/**
 * Addresses typed into a box, separated by commas, semicolons, spaces or new
 * lines: lower-cased, once each, and the ones that are not addresses listed
 * apart so the TA is told instead of the email quietly going without them.
 */
export function parseAddressList(raw: string | null | undefined): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const part of String(raw ?? "").split(/[,;\s]+/)) {
    const a = part.trim().toLowerCase();
    if (!a) continue;
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(a)) bad.push(part.trim());
    else if (!ok.includes(a)) ok.push(a);
  }
  return { ok, bad };
}

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
  introText?: string;
  outroText?: string;
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

  const formatParagraph = (text: string) =>
    text
      .split(/\n{2,}/)
      .map((p) => `<p>${p.split("\n").map(esc).join("<br>")}</p>`)
      .join("");

  const intro =
    input.introText && input.introText.trim()
      ? formatParagraph(input.introText.trim())
      : `<p>Dear Sir,<br><br>Please find the attached Shortlisted CV for the above-mentioned position</p>`;

  const outro =
    input.outroText && input.outroText.trim()
      ? formatParagraph(input.outroText.trim())
      : `<p>Thank You<br>Best Regards,<br><br>${esc(input.senderName)}<br>${esc(input.senderTitle ?? "Executive - Talent Acquisition")}</p>`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.7;color:#171c18">
${intro}
${shortlist}
${effort}
${input.attachmentNote ? `<p style="color:#6b736d">${esc(input.attachmentNote)}</p>` : ""}
${outro}
</div>`;
}
