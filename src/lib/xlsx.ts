import { zipStore } from "@/lib/zip";

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
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
function sanitizeCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  if (/^[=+\-@]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

/**
 * 1-based column number to Excel column letters (1 -> A, 27 -> AA).
 */
function colLetter(colIdx: number): string {
  let s = "";
  let n = colIdx;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

export interface XlsxSheet {
  name?: string;
  headers: string[];
  rows: string[][];
}

/**
 * Generate a standalone OpenXML (.xlsx) file buffer without external dependencies.
 * Uses inline strings (ECMA-376) so no separate shared strings table is required.
 */
export function buildXlsx({ name = "Excel Tables", headers, rows }: XlsxSheet): Buffer {
  const sheetName = (name || "Sheet1").replace(/[:\\/?*\[\]]/g, "_").slice(0, 31);

  // Compute column widths based on max content length
  const colWidths: number[] = headers.map((h, i) => {
    let maxLen = h.length;
    for (const r of rows) {
      const len = (r[i] ?? "").length;
      if (len > maxLen) maxLen = len;
    }
    return Math.max(12, Math.min(maxLen + 3, 50));
  });

  const colsXml = colWidths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");

  const sheetRowsXml: string[] = [];

  // Header row (row 1, style s="1" for bold & subtle fill)
  const headerCellsXml = headers
    .map((h, cIdx) => {
      const cellRef = `${colLetter(cIdx + 1)}1`;
      return `<c r="${cellRef}" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(h)}</t></is></c>`;
    })
    .join("");
  sheetRowsXml.push(`<row r="1" spans="1:${headers.length}">${headerCellsXml}</row>`);

  // Data rows (starting at row 2, style s="0")
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const rowNum = rIdx + 2;
    const row = rows[rIdx];
    const cellsXml = headers
      .map((_, cIdx) => {
        const cellRef = `${colLetter(cIdx + 1)}${rowNum}`;
        const val = sanitizeCell(row[cIdx] ?? "");
        if (!val) return "";
        return `<c r="${cellRef}" t="inlineStr" s="0"><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`;
      })
      .filter(Boolean)
      .join("");

    sheetRowsXml.push(`<row r="${rowNum}" spans="1:${headers.length}">${cellsXml}</row>`);
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF101828"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/></border>
    <border>
      <left style="thin"><color rgb="FFE4E7EC"/></left>
      <right style="thin"><color rgb="FFE4E7EC"/></right>
      <top style="thin"><color rgb="FFE4E7EC"/></top>
      <bottom style="medium"><color rgb="FF98A2B3"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`;

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${colsXml}</cols>
  <sheetData>${sheetRowsXml.join("")}</sheetData>
</worksheet>`;

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRelsXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRelsXml, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet1Xml, "utf8") },
  ];

  return zipStore(files);
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

export const EXCEL_TABLES_EXPORT_HEADERS = [
  "Candidate Name",
  "Title / Role",
  "Company",
  "Phone Number",
  "Phone Source",
  "Email",
  "LinkedIn URL",
  "Sheet / Level",
  "Status / Interest",
  "Add-on",
  "Added By",
  "Date Added",
  "Notes",
] as const;

const PHONE_SOURCE_LABELS: Record<string, string> = {
  mutual_connection: "Mutual connection",
  reception_call: "Reception / switchboard",
  internal_db: "Internal database",
  profile: "On profile",
  other: "Other",
};

/**
 * Maps LinkVaultEntry records into the standardized export rows matching EXCEL_TABLES_EXPORT_HEADERS.
 */
export function formatLinkVaultExportRows(
  entries: {
    name?: string | null;
    title?: string | null;
    company?: string | null;
    phoneNumber?: string | null;
    phoneSource?: string | null;
    linkedinUrl: string;
    level?: number | null;
    isAddOn?: boolean;
    createdAt: number;
    interest?: string | null;
    addedByName?: string | null;
    capture?: {
      fullName?: string | null;
      currentTitle?: string | null;
      headline?: string | null;
      currentCompany?: string | null;
      phone?: string | null;
      email?: string | null;
    } | null;
    notes?: string | null;
  }[]
): string[][] {
  return entries.map((r) => {
    const candidateName = r.name || r.capture?.fullName || "—";
    const title = r.title || r.capture?.currentTitle || r.capture?.headline || "—";
    const company = r.company || r.capture?.currentCompany || "—";
    const phone = r.phoneNumber || r.capture?.phone || "—";
    const phoneSource = r.phoneSource ? (PHONE_SOURCE_LABELS[r.phoneSource] ?? r.phoneSource) : "—";
    const email = r.capture?.email || "—";
    const linkedinUrl = r.linkedinUrl;
    const sheet = r.level ? `L${r.level}` : "All";
    const status = r.interest ? r.interest.charAt(0).toUpperCase() + r.interest.slice(1).replace("_", " ") : "Pending";
    const addon = r.isAddOn ? "Yes" : "No";
    const addedBy = r.addedByName || "—";
    const dateAdded = r.createdAt
      ? new Date(r.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "—";
    const notes = r.notes || "—";

    return [
      candidateName,
      title,
      company,
      phone,
      phoneSource,
      email,
      linkedinUrl,
      sheet,
      status,
      addon,
      addedBy,
      dateAdded,
      notes,
    ];
  });
}

