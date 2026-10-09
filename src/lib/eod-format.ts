import type { Candidate, Id, Role } from "@/data/types";
import { noticePeriodToDays } from "./answered";
import { externalUrl } from "./url";

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
  // A TA who typed the cell the way the email shows it ("2 · 14 CVs") got the
  // count twice (1 Oct): whatever CV count they typed gives way to the real one.
  const typed = String(sets ?? "").replace(/\s*·?\s*\d+\s*CVs?\s*$/i, "").trim();
  return typed ? `${typed} · ${cvs}` : cvs;
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

/**
 * Who the Director's end-of-day email actually goes to.
 *
 * The desk's To and Cc (and the shortlist inbox) start on it; the TA can take
 * any of them off and add others (1 Oct). The ones taken off are named in
 * `removed`; an address added back by hand goes where it was added, so taking
 * joborders@ off To and adding it as Cc moves it. Nobody is on both lines.
 */
export function eodRecipients(opts: {
  removed: string[];
  extraTo: string[];
  extraCc: string[];
  shortlistInbox: string;
}): { to: string[]; cc: string[] } {
  const off = new Set(opts.removed.map((a) => a.trim().toLowerCase()));
  const once = (list: string[], except: string[] = []) => {
    const out: string[] = [];
    for (const raw of list) {
      const a = raw.trim().toLowerCase();
      if (a && !except.includes(a) && !out.includes(a)) out.push(a);
    }
    return out;
  };
  const kept = (list: readonly string[]) => list.filter((a) => a && !off.has(a.trim().toLowerCase()));
  const to = once([...kept([EOD_TO]), ...opts.extraTo]);
  const cc = once([...kept(EOD_CC_DEFAULTS), ...kept([opts.shortlistInbox]), ...opts.extraCc], to);
  return { to, cc };
}

/**
 * The subject of an end-of-day email sent again, corrected (8 Oct):
 * "REVISED - SET 2 - DELMO - BRAND MANAGER - 3 CVs", so the Director can tell
 * which is current. Once only, however many times it is resent. The reply is
 * still matched to the same round (lib/routing strippedSubject ignores it).
 */
export function revisedSubject(subject: string): string {
  const bare = subject.trim().replace(/^(?:revised\s*[-:–—]?\s*)+/i, "").trim();
  return `REVISED - ${bare}`;
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Strips formatting markers (==highlight==, **bold**, *italic*, <mark>) for plain text / PDF. */
export function stripNoteFormatting(n: string): string {
  return String(n ?? "")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/<\/?mark[^>]*>/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .trim();
}

/** Formats a note line for email HTML with highlighted points, bold text, and clean bullets. */
export function formatNoteHtml(note: string): string {
  let line = esc(note.trim());
  const highlightStyle =
    "background-color:#fef08a;color:#171c18;font-weight:600;padding:1px 4px;border-radius:2px;display:inline-block;";

  // Replace ==highlight==
  line = line.replace(/==([^=]+)==/g, `<mark style="${highlightStyle}">$1</mark>`);

  // Replace &lt;mark(?:\s+[^&]*)?&gt;(.*?)&lt;\/mark&gt;
  line = line.replace(/&lt;mark(?:&gt;|\s+[^&]*&gt;)(.*?)&lt;\/mark&gt;/gi, `<mark style="${highlightStyle}">$1</mark>`);

  // Replace **bold**
  line = line.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

  // Replace *italic*
  line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");

  // Format leading bullet / chevron
  if (line.startsWith("&gt; ")) {
    line = `<span style="color:#6b736d;font-weight:600;margin-right:3px;">&rsaquo;</span> ${line.slice(5).trim()}`;
  } else if (line.startsWith("&gt;")) {
    line = `<span style="color:#6b736d;font-weight:600;margin-right:3px;">&rsaquo;</span> ${line.slice(4).trim()}`;
  } else if (line.startsWith("- ")) {
    line = `<span style="color:#6b736d;margin-right:3px;">&bull;</span> ${line.slice(2).trim()}`;
  }

  return line;
}

// ─── The research link (8 Oct) ───────────────────────────────────────────────
//
// Every TA's end-of-day email carries the ChatGPT conversation they researched
// with, so the TA leads, directors and anyone copied can open it. Whether a
// recipient can really open a link cannot be checked from here (ChatGPT does not
// answer a server, and a server-side fetch would be an open door), so the rule
// is: it must be a ChatGPT *share* link, and the sender confirms they opened it
// in a private window. Pure, so it is tested and the composer can use it too.

export type ResearchLinkCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Exact hosts, never a substring: chatgpt.com.evil.example must not pass. */
const RESEARCH_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);

export function validateResearchLink(raw: string | null | undefined): ResearchLinkCheck {
  const said = (raw ?? "").trim();
  if (!said) return { ok: false, reason: "Add your ChatGPT research link." };
  if (said.length > 300) return { ok: false, reason: "That is too long to be a ChatGPT share link." };
  // Two links, or a link inside a sentence: externalUrl would glue them into one address.
  if (/\s/.test(said)) return { ok: false, reason: "Paste only the link, with nothing before or after it." };
  const safe = externalUrl(said);
  if (!safe) return { ok: false, reason: "That is not a web address. Paste the ChatGPT share link." };
  const u = new URL(safe);
  if (!RESEARCH_HOSTS.has(u.hostname.toLowerCase())) {
    return { ok: false, reason: "Only ChatGPT share links (chatgpt.com/share/…) are accepted." };
  }
  if (/^\/(c|g|gpts?|chat)(\/|$)/i.test(u.pathname)) {
    return { ok: false, reason: "That is your private chat link, and only you can open it. In ChatGPT choose Share, then Create link, and paste that one." };
  }
  const m = u.pathname.match(/^\/share\/(?:e\/)?([A-Za-z0-9_-]{8,})\/?$/);
  if (!m) return { ok: false, reason: "That is not a ChatGPT share link. It should look like chatgpt.com/share/…" };
  // https, the path only: a query or fragment is tracking, not part of the share.
  return { ok: true, url: `https://${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}` };
}

/** Who must attach one: a TA sending the email that goes to the directors. Leads, directors and admins are exempt; the client copy sends no email. */
export function needsResearchLink(role: Role, kind: "director" | "client"): boolean {
  return role === "ta" && kind === "director";
}

/**
 * What the send does with the link it was given. Where one is needed it must be
 * a valid share link and the sender must have confirmed it; where it is not, a
 * valid one is still used and anything else is ignored rather than blocking.
 */
export function checkResearchSubmission(input: {
  role: Role;
  kind: "director" | "client";
  link: string | null | undefined;
  confirmed: boolean;
}): { ok: true; url: string | null } | { ok: false; reason: string } {
  const checked = validateResearchLink(input.link);
  if (!needsResearchLink(input.role, input.kind)) return { ok: true, url: checked.ok && input.kind === "director" ? checked.url : null };
  if (!checked.ok) return { ok: false, reason: checked.reason };
  if (!input.confirmed) {
    return { ok: false, reason: "Tick the box to confirm you opened the link in a private window and it holds no candidate details." };
  }
  return { ok: true, url: checked.url };
}

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
  /** The TA's ChatGPT research link; checked again here, so only a share link is ever written as an address. */
  researchLink?: string | null;
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
          `<tr><td ${td}>${r.no}</td><td ${td}><b>${esc(r.name)}</b></td><td ${td}>${esc(r.age)}</td><td ${td}>${esc(r.notice)}</td><td ${td}>${r.notes.map(formatNoteHtml).join("<br>")}</td><td ${td}>${esc(r.currentCompany)}</td><td ${td}>${esc(r.currentDesignation)}</td><td ${td}>${esc(r.currentRemuneration)}</td><td ${td}>${esc(r.expectedRemuneration)}</td></tr>`,
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

  // The anchor, and the address itself in small type for a client that strips links.
  const checked = input.researchLink ? validateResearchLink(input.researchLink) : null;
  const research = checked?.ok
    ? `<p style="margin:12px 0"><b>Research:</b> <a href="${esc(checked.url)}" style="color:#165b42">View ChatGPT Research</a><br><span style="font-size:11px;color:#6b736d">${esc(checked.url)}</span></p>`
    : "";

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
${research}
${input.attachmentNote ? `<p style="color:#6b736d">${esc(input.attachmentNote)}</p>` : ""}
${outro}
</div>`;
}
/** The lines the table writes itself (HOUSE_NOTE), not the TA's own notes. */
const isHouseLine = (n: string) => {
  const stripped = stripNoteFormatting(n);
  return /^>?\s*(Total Experience - |Currently at )/i.test(stripped.trim());
};
// Highlight and bold are the email's styling (30 Sep): the words are saved to
// the candidate, the ==marks== and **stars** are not — they would show as raw
// symbols on the profile and in Director review. Styling alone is no change.
const taNotes = (notes: string[]) =>
  notes.filter((n) => !isHouseLine(n)).map((n) => stripNoteFormatting(n.replace(/^>/, ""))).filter(Boolean);

/**
 * What the TA changed on the Director's email that belongs on the candidate
 * (the desk, 29 Sep): salaries, notice and their own notes — the same details
 * as the CV's box and the Director review form. Saved when the email goes, so
 * the CV, the profile and the next email say what this one said. Null when
 * nothing of these was changed. Name and age are the email's wording only and
 * stay there; company and designation are saved too since the TA corrects
 * them on the profile (owner, 9 Oct).
 */
type DetailPatch = Partial<
  Pick<Candidate, "currentSalary" | "expectedSalary" | "noticePeriodDays" | "noticePeriod" | "currentTitle" | "currentEmployer">
>;

export function eodDetailChanges(
  base: ShortlistRow,
  edited: ShortlistRow,
): {
  patch: DetailPatch;
  notes: string[] | null;
} | null {
  const patch: DetailPatch = {};
  // A copy saved before these columns were editable may not carry them.
  const said = (v: string | undefined) => (v ?? "").trim();
  if (said(edited.currentDesignation) !== said(base.currentDesignation)) {
    patch.currentTitle = said(edited.currentDesignation) || null;
  }
  if (said(edited.currentCompany) !== said(base.currentCompany)) {
    patch.currentEmployer = said(edited.currentCompany) || null;
  }
  if (edited.currentRemuneration.trim() !== base.currentRemuneration.trim()) {
    patch.currentSalary = edited.currentRemuneration.trim() || null;
  }
  if (edited.expectedRemuneration.trim() !== base.expectedRemuneration.trim()) {
    patch.expectedSalary = edited.expectedRemuneration.trim() || null;
  }
  if (edited.notice.trim() !== base.notice.trim()) {
    const text = edited.notice.trim();
    patch.noticePeriod = text || null;
    patch.noticePeriodDays = text ? noticePeriodToDays(text) : null;
  }
  const before = taNotes(base.notes);
  const after = taNotes(edited.notes);
  const notes = JSON.stringify(before) === JSON.stringify(after) ? null : after;
  return Object.keys(patch).length || notes ? { patch, notes } : null;
}

/**
 * The box's lines the TA changed on the email, over what the desk holds
 * (29 Sep): the attachment and its preview say what the email says, and a
 * field the TA did not touch comes from the record — so the table's own
 * "Not disclosed" for an unknown salary never reaches the CV.
 */
export function boxOverrides(change: ReturnType<typeof eodDetailChanges>): {
  currentDesignation?: string | null;
  currentCompany?: string | null;
  currentSalary?: string | null;
  expectedSalary?: string | null;
  noticePeriod?: string | null;
  notes?: string[];
} {
  if (!change) return {};
  const out: ReturnType<typeof boxOverrides> = {};
  if ("currentTitle" in change.patch) out.currentDesignation = change.patch.currentTitle ?? null;
  if ("currentEmployer" in change.patch) out.currentCompany = change.patch.currentEmployer ?? null;
  if ("currentSalary" in change.patch) out.currentSalary = change.patch.currentSalary ?? null;
  if ("expectedSalary" in change.patch) out.expectedSalary = change.patch.expectedSalary ?? null;
  if ("noticePeriod" in change.patch) out.noticePeriod = change.patch.noticePeriod ?? null;
  if (change.notes) out.notes = change.notes;
  return out;
}
