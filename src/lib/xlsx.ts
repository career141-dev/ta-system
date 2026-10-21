import { zipStore } from "@/lib/zip";
import { escapeXml, sanitizeCell, detectHyperlink } from "@/lib/spreadsheetClipboard";
export { toTsv, toHtmlTable, detectHyperlink } from "@/lib/spreadsheetClipboard";

function colLetter(n: number): string {
  let result = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    result = String.fromCharCode(65 + m) + result;
    n = Math.floor((n - m) / 26);
  }
  return result;
}

export interface XlsxSheet {
  name?: string;
  headers: string[];
  rows: string[][];
  /** Zero-based indexes in rows, excluding the column header. */
  sectionRows?: number[];
}

/** Excel names are case-insensitively unique, including after truncation. */
export function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = raw.replace(/[\u0000-\u001f:\\/?*\[\]]/g, "_").trim().replace(/^'+|'+$/g, "") || "Sheet";
    let name = base.slice(0, 31).replace(/'+$/g, "");
    let index = 2;
    while (used.has(name.toLowerCase()) || name.toLowerCase() === "history") {
      const suffix = ` (${index++})`;
      name = base.slice(0, 31 - suffix.length).replace(/'+$/g, "") + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const mainNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRelNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A dependency-free OpenXML writer shared by email and download exports. */
export function buildXlsx(input: XlsxSheet | { sheets: XlsxSheet[] }): Buffer {
  const sheets = "sheets" in input ? input.sheets : [input];
  if (!sheets.length) throw new Error("An Excel workbook needs at least one sheet.");
  const names = uniqueSheetNames(sheets.map((s) => s.name ?? "Excel Tables"));
  const files: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, xml: string) => files.push({ name, data: Buffer.from(xmlHeader + xml, "utf8") });

  add("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
    <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    ${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
  </Types>`);
  add("_rels/.rels", `<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRelNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add("xl/workbook.xml", `<workbook xmlns="${mainNs}" xmlns:r="${officeRelNs}"><sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  add("xl/_rels/workbook.xml.rels", `<Relationships xmlns="${relNs}">
    ${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${officeRelNs}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
    <Relationship Id="rId${sheets.length + 1}" Type="${officeRelNs}/styles" Target="styles.xml"/>
  </Relationships>`);
  // Only status cells receive fills: Interested green, Pending yellow, Not Interested red.
  add("xl/styles.xml", `<styleSheet xmlns="${mainNs}">
    <fonts count="3">
      <font><sz val="11"/><name val="Calibri"/></font>
      <font><b/><sz val="11"/><name val="Calibri"/></font>
      <font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>
    </fonts>
    <fills count="5">
      <fill><patternFill patternType="none"/></fill>
      <fill><patternFill patternType="gray125"/></fill>
      ${["FFE2F0D9", "FFFFF2CC", "FFFFE2E2"].map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`).join("")}
    </fills>
    <borders count="1"><border><left/><right/><top/><bottom/></border></borders>
    <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
    <cellXfs count="6">
      ${[0, 1, 2, 0, 0, 0].map((font, i) => `<xf numFmtId="0" fontId="${font}" fillId="${i >= 3 ? i - 1 : 0}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`).join("")}
    </cellXfs>
    <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  </styleSheet>`);

  sheets.forEach((sheet, sheetIndex) => {
    const { headers, rows } = sheet;
    const sections = new Set(sheet.sectionRows ?? []);
    const links: { ref: string; url: string }[] = [];
    const cols = headers.map((h, i) => {
      let maxLength = h.length;
      rows.forEach((r, index) => { if (!sections.has(index)) maxLength = Math.max(maxLength, (r[i] ?? "").length); });
      const width = Math.max(12, Math.min(maxLength + 3, h === "Notes" ? 60 : 50));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    }).join("");
    const rowXml = [headers, ...rows].map((row, r) => {
      const section = r > 0 && sections.has(r - 1);
      const cells = headers.map((header, c) => {
        const value = sanitizeCell(row[c] ?? "");
        if (!value) return "";
        const ref = `${colLetter(c + 1)}${r + 1}`;
        let style = r === 0 || section ? 1 : 0;
        // Section labels and arbitrary notes must not turn into web addresses.
        const link = r > 0 && !section && /link|url/i.test(header) ? detectHyperlink(value, header) : null;
        if (link) {
          links.push({ ref, url: link.url });
          style = 2;
        } else if (r > 0 && !section && header === "Status") {
          style = ({ Interested: 3, Pending: 4, "Not Interested": 5 } as Record<string, number>)[value] ?? 0;
        }
        return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    add(`xl/worksheets/sheet${sheetIndex + 1}.xml`, `<worksheet xmlns="${mainNs}" xmlns:r="${officeRelNs}">
      <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
      <cols>${cols}</cols><sheetData>${rowXml}</sheetData>
      ${links.length ? `<hyperlinks>${links.map((link, i) => `<hyperlink ref="${link.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>` : ""}
    </worksheet>`);
    if (links.length) add(`xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`, `<Relationships xmlns="${relNs}">${links.map((link, i) => `<Relationship Id="rId${i + 1}" Type="${officeRelNs}/hyperlink" Target="${escapeXml(link.url)}" TargetMode="External"/>`).join("")}</Relationships>`);
  });
  return zipStore(files);
}

export const EXCEL_TABLES_EXPORT_HEADERS = ["Candidate Name", "Links", "Status", "Notes"] as const;

export function formatLinkVaultExportRows(entries: {
  name?: string | null;
  linkedinUrl: string;
  interest?: string | null;
  capture?: { fullName?: string | null } | null;
  notes?: string | null;
}[]): string[][] {
  return entries.map((r) => [
    r.name || r.capture?.fullName || "—",
    r.linkedinUrl,
    ({ interested: "Interested", pending: "Pending", not_interested: "Not Interested" } as Record<string, string>)[r.interest ?? "pending"] ?? "Pending",
    r.notes || "—",
  ]);
}
