/**
 * The Referee Calls sheet, without the page (23 Oct): what a paste from Excel
 * becomes, what a copy puts on the clipboard, and what Save has to send.
 *
 * The desk asked for the table to work like their Excel sheet — type anywhere,
 * paste a block, save once. The first grid saved each row as soon as one cell
 * had text and then locked it, so the other three cells could not be typed.
 */

export const GRID_FIELDS = ["company", "referral", "contactNumber", "feedback"] as const;
export type GridField = (typeof GRID_FIELDS)[number];

/** One line of the sheet. `id` is set once the server holds it. */
export interface GridRow {
  key: string;
  id?: string;
  company: string;
  referral: string;
  contactNumber: string;
  feedback: string;
}

export type GridValues = Pick<GridRow, GridField>;

/** At most this many rows in one save — a pasted sheet, not a database import. */
export const MAX_GRID_ROWS = 300;
export const FIELD_MAX: Record<GridField, number> = { company: 200, referral: 200, contactNumber: 100, feedback: 2000 };

export const isBlankRow = (row: GridValues): boolean => GRID_FIELDS.every((f) => !String(row[f] ?? "").trim());

/**
 * Text copied from Excel or Google Sheets: rows on new lines, cells on tabs.
 * A cell that itself holds a tab, a new line or a quote comes quoted, with
 * quotes doubled; those are kept whole. The final new line Excel adds is not
 * a row.
 */
export function parsePastedBlock(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  let atCellStart = true;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && atCellStart) { quoted = true; atCellStart = false; i++; continue; }
    if (ch === "\t") { row.push(cell); cell = ""; atCellStart = true; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; atCellStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch; atCellStart = false; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A selected block as Excel reads it back: tabs and new lines, quoted where a cell needs it. */
export function toTsv(block: string[][]): string {
  const quote = (v: string) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return block.map((r) => r.map(quote).join("\t")).join("\n");
}

/**
 * A pasted block written into the sheet from the active cell, right and down.
 * Lines past the last row become new rows; columns past Feedback are dropped.
 * Rows the viewer may not edit are left as they are.
 */
export function applyPaste(
  rows: GridRow[],
  at: { r: number; c: number },
  block: string[][],
  newKey: () => string,
  canEdit: (row: GridRow) => boolean = () => true,
): GridRow[] {
  const next = rows.map((r) => ({ ...r }));
  const lines = block.slice(0, Math.max(0, MAX_GRID_ROWS - at.r));
  lines.forEach((cells, i) => {
    const r = at.r + i;
    while (next.length <= r) next.push(emptyRow(newKey()));
    if (!canEdit(next[r])) return;
    cells.forEach((value, j) => {
      const c = at.c + j;
      if (c >= GRID_FIELDS.length) return;
      next[r][GRID_FIELDS[c]] = value.trim();
    });
  });
  return next;
}

export const emptyRow = (key: string): GridRow => ({ key, company: "", referral: "", contactNumber: "", feedback: "" });

export interface GridChanges {
  add: (GridValues & { key: string })[];
  update: (GridValues & { id: string })[];
  remove: string[];
}

const same = (a: GridValues, b: GridValues) => GRID_FIELDS.every((f) => String(a[f] ?? "").trim() === String(b[f] ?? "").trim());
const values = (r: GridValues): GridValues => ({
  company: r.company.trim(), referral: r.referral.trim(), contactNumber: r.contactNumber.trim(), feedback: r.feedback.trim(),
});

/**
 * What Save sends: new rows with any text, saved rows whose text changed, and
 * saved rows that were removed or cleared. A row typed back to what was saved
 * is not a change.
 */
export function diffRows(saved: ReadonlyMap<string, GridValues>, rows: GridRow[]): GridChanges {
  const changes: GridChanges = { add: [], update: [], remove: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id) {
      if (!isBlankRow(row)) changes.add.push({ key: row.key, ...values(row) });
      continue;
    }
    seen.add(row.id);
    const before = saved.get(row.id);
    if (!before) continue;
    if (isBlankRow(row)) changes.remove.push(row.id);
    else if (!same(before, row)) changes.update.push({ id: row.id, ...values(row) });
  }
  for (const id of saved.keys()) if (!seen.has(id)) changes.remove.push(id);
  return changes;
}

export const changeCount = (c: GridChanges): number => c.add.length + c.update.length + c.remove.length;
