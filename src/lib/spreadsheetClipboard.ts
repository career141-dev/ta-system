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
 * Detect whether a cell value is a web hyperlink (such as a LinkedIn profile link).
 * Returns the resolved destination URL, or null if not a hyperlink.
 */
export function detectHyperlink(rawVal: string, header?: string): { url: string } | null {
  if (!rawVal) return null;
  let s = rawVal.trim();
  // Strip formula guard quote if present
  if (s.startsWith("'")) s = s.slice(1).trim();
  if (!s || s === "—" || s === "-") return null;

  // Direct http/https URLs
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) {
        return { url: s };
      }
    } catch {}
  }

  // www. links
  if (/^www\./i.test(s)) {
    try {
      const u = new URL(`https://${s}`);
      if (u.hostname.includes(".")) {
        return { url: `https://${s}` };
      }
    } catch {}
  }

  // If header indicates a URL/link column (e.g. "LinkedIn URL", "Profile Link")
  if (header && /url|link/i.test(header)) {
    // Avoid email addresses or non-link values
    if (s.includes("@") && !s.includes("/")) return null;
    const prefixed = /^[a-z0-9+.-]+:\/\//i.test(s) ? s : `https://${s}`;
    try {
      const u = new URL(prefixed);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) {
        return { url: prefixed };
      }
    } catch {}
  }

  return null;
}

/**
 * Format headers and rows as HTML <table> for rich clipboard copy into Excel.
 */
export function toHtmlTable(headers: string[], rows: string[][]): string {
  const ths = headers.map((h) => `<th style="font-weight:bold;border:1px solid #d0d5dd;padding:6px 10px;">${escapeXml(h)}</th>`).join("");
  const trs = rows
    .map((r) => {
      const tds = headers
        .map((h, i) => {
          const raw = r[i] ?? "";
          const val = sanitizeCell(raw);
          const link = detectHyperlink(val, h);
          const inner = link
            ? `<a href="${escapeXml(link.url)}" style="color:#0563c1;text-decoration:underline;">${escapeXml(val)}</a>`
            : escapeXml(val);
          const color = h === "Status" ? ({ Interested: "#e2f0d9", Pending: "#fff2cc", "Not Interested": "#ffe2e2" } as Record<string, string>)[val] : null;
          return `<td style="border:1px solid #eaecf0;padding:5px 8px;${color ? `background-color:${color};` : ""}">${inner}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return `<table style="border-collapse:collapse;font-family:Calibri,sans-serif;font-size:11pt;"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

