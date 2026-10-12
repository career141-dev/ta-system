/**
 * Escape XML special characters.
 */
export function escapeXml(str: string): string {
  // XML 1.0 forbids most C0 controls; a single one can make Excel reject the
  // entire workbook when it appears in a copied note or candidate field.
  return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Guard against formula injection in spreadsheets (=, +, -, @).
 */
export function sanitizeCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  if (/^[=+\-@]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

/**
 * Format headers and rows as Tab-Separated Values (TSV) for clipboard copy into Excel.
 */
export function toTsv(headers: string[], rows: string[][]): string {
  const sanitizeTsvCell = (val: string) => {
    const s = sanitizeCell(val);
    // Replace newlines and tabs so they don't break TSV row/column boundaries
    return s.replace(/[\r\n\t]/g, " ");
  };

  const lines = [
    headers.map(sanitizeTsvCell).join("\t"),
    ...rows.map((r) => headers.map((_, i) => sanitizeTsvCell(r[i] ?? "")).join("\t")),
  ];
  return lines.join("\r\n");
}

/**
 * Format headers and rows as HTML <table> for rich clipboard copy into Excel.
 */
export function toHtmlTable(headers: string[], rows: string[][]): string {
  const ths = headers.map((h) => `<th style="background-color:#f2f4f7;font-weight:bold;border:1px solid #d0d5dd;padding:6px 10px;">${escapeXml(h)}</th>`).join("");
  const trs = rows
    .map((r) => {
      const tds = headers
        .map((_, i) => `<td style="border:1px solid #eaecf0;padding:5px 8px;">${escapeXml(sanitizeCell(r[i] ?? ""))}</td>`)
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return `<table style="border-collapse:collapse;font-family:Calibri,sans-serif;font-size:11pt;"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}
