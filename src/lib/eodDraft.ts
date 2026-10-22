import type { ShortlistRow } from "./eod-format";
import { workdayDate } from "./workday";

export function eodDraftKeys(openingId: string, kind: string, effortDate: string, actorId?: string, workLocationId?: string, parentId?: string, date = workdayDate(Date.now())) {
  const scope = workLocationId ? `${openingId}:${actorId}:${workLocationId}:${date}` : openingId;
  return {
    composer: `eod-composer-draft:${scope}:${kind}${parentId ? `:resend:${parentId}` : ""}`,
    effort: `eod-effort:${scope}:${parentId ? `resend:${parentId}` : effortDate}`,
  };
}

/** Every client-side edit that must survive navigation and a rejected send. */
export interface EodBrowserDraft {
  subject: string;
  baseSubject: string;
  introText: string;
  outroText: string;
  researchLink: string;
  shortlistDraft: Record<string, CandidateDraft>;
  extraTo: string;
  extraCc: string;
  removed: string;
  skipAttachments: boolean;
}

export function encodeEodBrowserDraft(draft: EodBrowserDraft): string {
  return JSON.stringify(draft);
}

export function decodeEodBrowserDraft(value: string | null): Partial<EodBrowserDraft> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One candidate's edits in the EOD box, and what the record said under each
 * edit. A record that has changed since means the TA updated the profile after
 * typing, so the profile's value goes out instead of the older edit (22 Oct).
 */
export type CandidateDraft = Partial<ShortlistRow> & { _base?: Partial<Record<keyof ShortlistRow, string>> };

/** A box field as text: notes one per line, as the form sends them. */
export function draftFieldText(value: unknown): string {
  return Array.isArray(value) ? value.join("\n") : value == null ? "" : String(value);
}

/**
 * Keeps an edit over what the record says now. Never over an earlier base:
 * after a profile update that would drop every key the TA typed into the box.
 */
export function editCandidateDraft(draft: CandidateDraft | undefined, row: ShortlistRow | undefined, field: keyof ShortlistRow, value: unknown): CandidateDraft {
  return { ...draft, [field]: value, _base: { ...draft?._base, ...(row ? { [field]: draftFieldText(row[field]) } : {}) } };
}

/**
 * The row the email carries. A field saved without a base (every draft before
 * 22 Oct) keeps the TA's edit: guessing from the notes' wording dropped edits
 * a TA had made on purpose, and the original notes went to the Director.
 */
export function applyCandidateDraft(row: ShortlistRow, draft: CandidateDraft | undefined): ShortlistRow {
  if (!draft) return row;
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(draft)) {
    if (key === "_base" || value === undefined) continue;
    const base = draft._base?.[key as keyof ShortlistRow];
    if (base !== undefined && base !== draftFieldText(row[key as keyof ShortlistRow])) continue;
    out[key] = value;
  }
  return out as unknown as ShortlistRow;
}

/** A saved midday/EOD draft's shortlist fields, back as candidate edits with their bases. */
export function candidateDraftsFromFields(rows: ShortlistRow[], fields: Record<string, string>): Record<string, CandidateDraft> {
  return Object.fromEntries(rows.map(row => {
    const draft: Record<string, unknown> = {};
    const base: Record<string, string> = {};
    for (const key of Object.keys(row)) {
      const value = fields[`shortlist_${row.applicationId}_${key}`];
      if (value === undefined) continue;
      draft[key] = key === "notes" ? value.split("\n") : value;
      const was = fields[`base_shortlist_${row.applicationId}_${key}`];
      if (was !== undefined) base[key] = was;
    }
    if (Object.keys(base).length) draft._base = base;
    return [row.applicationId, draft as CandidateDraft];
  }));
}

/**
 * Saved beside a server draft's shortlist fields. The box shows either the
 * record or an edit made over it as it stands, so the record now is the base.
 */
export function candidateDraftBases(rows: ShortlistRow[], fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) for (const key of Object.keys(row) as (keyof ShortlistRow)[]) {
    if (fields[`shortlist_${row.applicationId}_${key}`] !== undefined) out[`base_shortlist_${row.applicationId}_${key}`] = draftFieldText(row[key]);
  }
  return out;
}
