import type { ShortlistRow } from "./eod-format";

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
