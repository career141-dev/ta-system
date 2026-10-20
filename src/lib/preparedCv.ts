/**
 * The green CAREER141 box on the Prepared CV: what goes in it, and how it is
 * laid out (29 Sep).
 *
 * One source for both, used by the drawer's download, the end-of-day
 * attachments and the Prepared CV tab's editor — so the box the TA drags on
 * screen is the box that prints.
 *
 * What goes in: only what the desk actually holds. Unknown salaries used to
 * print "NOT DISCLOSED" / "OPEN TO DISCUSS" on their own, and the end-of-day
 * copy added "Total Experience" and "Currently at" lines nobody typed. A value
 * the TA typed — "Not disclosed" included — is an answer and prints.
 *
 * How it is laid out: one readable font size and a width the TA can adjust.
 * More text (or a narrower box) makes the box taller, never the text smaller.
 */

import type { Application, Candidate, Opening } from "@/data/types";
import { isSystemNote } from "./pdf";
import { BOX } from "./career141Box";
import { stripNoteFormatting } from "./eod-format";

export interface BoxContent {
  /** From the CV, or as the TA corrected it on the call (9 Oct). */
  currentDesignation?: string | null;
  currentCompany?: string | null;
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriod: string | null;
  notes: string[];
}

export { BOX };

/** The notice period as the desk wrote it, or from the day count. */
export function noticeText(c: Pick<Candidate, "noticePeriodDays"> & { noticePeriod?: string | null }): string | null {
  const words = c.noticePeriod?.trim();
  if (words) {
    if (/^immediate/i.test(words) || words === "0") return "Immediate";
    return /^\d+$/.test(words) ? `${words} Days` : words;
  }
  if (c.noticePeriodDays === 0) return "Immediate";
  if (c.noticePeriodDays != null) return `${c.noticePeriodDays} Days`;
  return null;
}

/** Everything the desk holds for this candidate on this opening, and nothing invented. */
export function boxContent(
  app: Pick<Application, "notes" | "answers">,
  c: Pick<Candidate, "currentSalary" | "expectedSalary" | "noticePeriodDays"> & {
    noticePeriod?: string | null;
    currentTitle?: string | null;
    currentEmployer?: string | null;
  },
  opening: Pick<Opening, "followUpQuestions"> | null,
): BoxContent {
  const notes = (app.notes ?? [])
    .map((n) => stripNoteFormatting(n.replace(/^>/, "").replace(/^[-•*]\s*/, "")))
    .filter((n) => n && !isSystemNote(n));
  // Answers to the opening's own follow-up questions are details the desk
  // gathered too; they never reached the box before.
  for (const q of opening?.followUpQuestions ?? []) {
    const a = app.answers?.[q.id]?.trim();
    if (a && !notes.some((n) => n.toLowerCase().startsWith(q.label.toLowerCase()))) notes.push(`${q.label}: ${a}`);
  }
  return {
    currentDesignation: c.currentTitle?.trim() || null,
    currentCompany: c.currentEmployer?.trim() || null,
    currentSalary: c.currentSalary?.trim() || null,
    expectedSalary: c.expectedSalary?.trim() || null,
    noticePeriod: noticeText(c),
    notes,
  };
}

/** The box's lines before wrapping; the first is the header. Empty values are left out. */
export function boxItems(b: BoxContent): string[] {
  const items = ["CAREER141 CANDIDATE"];
  // The Director reads who they are now before what they earn (owner, 9 Oct).
  if (b.currentDesignation) items.push(`CURRENT DESIGNATION - ${b.currentDesignation}`);
  if (b.currentCompany) items.push(`CURRENT COMPANY - ${b.currentCompany}`);
  if (b.currentSalary) items.push(`CURRENT SALARY - ${b.currentSalary}`);
  if (b.expectedSalary) items.push(`EXPECTED SALARY - ${b.expectedSalary}`);
  if (b.noticePeriod) items.push(`NOTICE PERIOD - ${b.noticePeriod}`);
  if (b.notes.length) {
    items.push("NOTE:-");
    for (const n of b.notes) items.push(`- ${n}`);
  }
  return items;
}

export function hasContent(b: BoxContent): boolean {
  return boxItems(b).length > 1;
}

/** Text width in points at a size. The PDF passes pdf-lib's own metrics. */
export type Measure = (text: string, size: number, bold: boolean) => number;

// ponytail: Helvetica averages ~0.5em per character; used only where pdf-lib's
// exact metrics are not to hand (the fallback PDF). Exact metrics are passed
// everywhere a real CV is stamped.
export const roughMeasure: Measure = (text, size) => text.length * size * 0.5;

export interface BoxLayout {
  lines: { text: string; bold: boolean }[];
  width: number;
  height: number;
}

/** A saved or dragged width, kept useful and inside the page when it is known. */
export function clampBoxWidth(width: number, pageWidth = Number.POSITIVE_INFINITY): number {
  const pageLimit = Number.isFinite(pageWidth) ? Math.max(80, pageWidth - 20) : BOX.maxWidth;
  const upper = Math.min(BOX.maxWidth, pageLimit);
  return Math.round(Math.min(Math.max(BOX.minWidth, width), upper));
}

/** Wrap every item to the chosen width, at the one readable font size. */
export function layoutBox(items: string[], measure: Measure, requestedWidth: number = BOX.width): BoxLayout {
  const width = clampBoxWidth(requestedWidth);
  const inner = width - BOX.padding * 2;
  const lines: BoxLayout["lines"] = [];
  items.forEach((item, i) => {
    const bold = i === 0;
    const size = bold ? BOX.headerSize : BOX.bodySize;
    const fits = (t: string) => measure(t, size, bold) <= inner;
    // Continuation lines are indented under the first.
    let line = "";
    for (const w of item.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && !fits(next)) {
        lines.push({ text: line, bold });
        line = `  ${w}`;
      } else {
        line = next;
      }
      // A single word wider than the box (a long link) is cut, not overflowed.
      while (!fits(line) && line.trim().length > 1) {
        let cut = line.length - 1;
        while (cut > 3 && !fits(line.slice(0, cut))) cut--;
        lines.push({ text: line.slice(0, cut), bold });
        line = `  ${line.slice(cut)}`;
      }
    }
    if (line.trim()) lines.push({ text: line, bold });
  });
  return { lines, width, height: BOX.padding * 2 + lines.length * BOX.lineHeight + 4 };
}

/**
 * Where the box goes, in points from the page's top-left: the TA's saved spot,
 * kept inside the page so a smaller page or a taller box never pushes it off.
 */
export function clampBox(
  at: { x: number; y: number },
  box: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  const m = 10;
  return {
    x: Math.round(Math.min(Math.max(m, at.x), Math.max(m, page.width - box.width - m))),
    y: Math.round(Math.min(Math.max(m, at.y), Math.max(m, page.height - box.height - m))),
  };
}
