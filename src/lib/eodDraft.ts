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
  shortlistDraft: Record<string, Partial<ShortlistRow>>;
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
