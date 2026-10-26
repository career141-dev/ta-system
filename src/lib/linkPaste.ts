/**
 * Rows copied out of a TA's own Excel sheet, pasted into Excel Tables at once
 * (26 October). The box took one link at a time, and Sameera's six LinkedIn
 * sheets held some two hundred. A row copied from Excel is its cells joined by
 * tabs; each row with a LinkedIn profile becomes one entry. The contact number
 * is kept as the row's phone, and the rest — company, designation, status —
 * as the TA's note on it, since the sheets lay those out every way there is.
 * Pure; tested in tests/linkpaste.test.ts.
 */

export interface PastedLink {
  url: string;
  phone: string | null;
  note: string;
}

const PROFILE = /linkedin\.com\/in\//i;
// A number, not a year or a row number: nine to fifteen digits once spaces,
// dashes, brackets and a leading + are taken out.
const phoneOf = (cell: string): string | null => {
  const digits = cell.replace(/[\s\-()+.]/g, "");
  return /^\d{9,15}$/.test(digits) ? cell.trim() : null;
};

export function parseLinkPaste(text: string): { rows: PastedLink[]; skipped: number } {
  const rows: PastedLink[] = [];
  let skipped = 0;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
    if (!cells.length) continue;
    const url = cells.find((c) => PROFILE.test(c));
    if (!url) { skipped++; continue; }
    let phone: string | null = null;
    const rest: string[] = [];
    for (const c of cells) {
      if (c === url) continue;
      const p: string | null = phone ? null : phoneOf(c);
      if (p) { phone = p; continue; }
      // A bare row number from the sheet's "No" column says nothing.
      if (/^\d{1,4}$/.test(c)) continue;
      rest.push(c);
    }
    rows.push({ url, phone, note: rest.join(" · ") });
  }
  return { rows, skipped };
}
