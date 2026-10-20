/**
 * Tests for Excel (.xlsx) builder and clipboard formatters (lib/xlsx).
 */
import { buildXlsx, formatLinkVaultExportRows, EXCEL_TABLES_EXPORT_HEADERS, detectHyperlink } from "@/lib/xlsx";
import { toTsv, toHtmlTable } from "@/lib/spreadsheetClipboard";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

/** Helper to inspect files inside a zip buffer */
function unzipFiles(buf: Buffer): Map<string, string> {
  const end = buf.length - 22;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const size = buf.readUInt32LE(at + 20);
    const local = buf.readUInt32LE(at + 42);
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size).toString("utf8");
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

console.log("\n1. OpenXML .xlsx generation");
const headers = ["Name", "Company", "Role", "Phone"];
const rows = [
  ["Alice Fernando", "Tech Corp", "Software Engineer", "+94 77 123 4567"],
  ["Bob Perera", "Finance & Co", "Analyst <Senior>", "=SUM(1,2)"], // test escaping & formula injection
  ['Charlie "Chuck"', "A&B Ltd", "Designer", ""],
];

const buf = buildXlsx({ name: "Export Test", headers, rows });
eq("buffer is returned", Buffer.isBuffer(buf), true);
eq("buffer starts with ZIP local file header", buf.readUInt32LE(0), 0x04034b50);
eq("buffer has non-trivial size", buf.length > 500, true);

const unzippedNoLinks = unzipFiles(buf);
eq("no rels file when there are no hyperlinks", unzippedNoLinks.has("xl/worksheets/_rels/sheet1.xml.rels"), false);
eq("no <hyperlinks> tag when there are no hyperlinks", unzippedNoLinks.get("xl/worksheets/sheet1.xml")?.includes("<hyperlinks>"), false);

console.log("\n2. TSV formatting for clipboard copy");
const tsv = toTsv(headers, rows);
eq("tsv contains header line", tsv.startsWith("Name\tCompany\tRole\tPhone"), true);
eq("tsv lines separated by CRLF", tsv.includes("\r\n"), true);
eq("tsv formula injection escaped with leading quote", tsv.includes("'=SUM(1,2)"), true);

console.log("\n3. HTML table formatting for clipboard copy");
const html = toHtmlTable(headers, rows);
eq("html table has table tags", html.startsWith("<table") && html.endsWith("</table>"), true);
eq("html table has th tags", html.includes(">Name</th>"), true);
eq("html table XML escapes special characters", html.includes("Finance &amp; Co") && html.includes("&lt;Senior&gt;"), true);

console.log("\n4. formatLinkVaultExportRows helper");
const sampleEntries = [
  {
    name: "Kasun Silva",
    title: "Lead Architect",
    company: "WSO2",
    phoneNumber: "0712345678",
    phoneSource: "mutual_connection",
    linkedinUrl: "https://www.linkedin.com/in/kasun-silva",
    level: 1,
    isAddOn: true,
    createdAt: 1728000000000,
    interest: "interested",
    addedByName: "Binath",
    capture: {
      fullName: "Kasun Silva",
      email: "kasun@wso2.com",
      phone: "0712345678",
    },
    notes: "Approached on LinkedIn",
  },
  {
    name: null,
    title: null,
    company: null,
    phoneNumber: null,
    phoneSource: null,
    linkedinUrl: "https://www.linkedin.com/in/jane-doe",
    level: null,
    isAddOn: false,
    createdAt: 1728000000000,
    interest: "pending",
    addedByName: null,
    capture: {
      fullName: "Jane Doe",
      currentTitle: "VP Sales",
      currentCompany: "Dialog",
      email: null,
    },
    notes: null,
  },
];

const exportRows = formatLinkVaultExportRows(sampleEntries);
eq("generates expected row count", exportRows.length, 2);
eq("first row has 13 columns matching headers", exportRows[0].length, EXCEL_TABLES_EXPORT_HEADERS.length);
eq("first row candidate name", exportRows[0][0], "Kasun Silva");
eq("first row company", exportRows[0][2], "WSO2");
eq("first row phone source resolved", exportRows[0][4], "Mutual connection");
eq("first row email extracted", exportRows[0][5], "kasun@wso2.com");
eq("first row level formatted", exportRows[0][7], "L1");
eq("first row status formatted", exportRows[0][8], "Interested");
eq("first row add-on flag", exportRows[0][9], "Yes");

eq("second row falls back to capture fullName", exportRows[1][0], "Jane Doe");
eq("second row falls back to capture currentTitle", exportRows[1][1], "VP Sales");
eq("second row falls back to capture currentCompany", exportRows[1][2], "Dialog");
eq("second row missing email falls back to dash", exportRows[1][5], "—");
eq("second row null level falls back to All", exportRows[1][7], "All");

console.log("\n5. detectHyperlink URL recognition");
eq("full https URL recognized", detectHyperlink("https://www.linkedin.com/in/kasun-silva")?.url, "https://www.linkedin.com/in/kasun-silva");
eq("www URL recognized and prefixed", detectHyperlink("www.linkedin.com/in/kasun-silva")?.url, "https://www.linkedin.com/in/kasun-silva");
eq("URL under LinkedIn URL header recognized", detectHyperlink("linkedin.com/in/kasun-silva", "LinkedIn URL")?.url, "https://linkedin.com/in/kasun-silva");
eq("dash is not a link", detectHyperlink("—", "LinkedIn URL"), null);
eq("empty string is not a link", detectHyperlink("", "LinkedIn URL"), null);
eq("email is not a link", detectHyperlink("kasun@wso2.com", "Email"), null);
eq("candidate name is not a link", detectHyperlink("Kasun Silva", "Candidate Name"), null);
eq("formula string is not a link", detectHyperlink("=SUM(1,2)"), null);

console.log("\n6. Hyperlink export in OpenXML and HTML table");
const vaultBuf = buildXlsx({
  name: "Excel Tables",
  headers: [...EXCEL_TABLES_EXPORT_HEADERS],
  rows: exportRows,
});
const unzippedVault = unzipFiles(vaultBuf);
eq("hyperlink rels file exists", unzippedVault.has("xl/worksheets/_rels/sheet1.xml.rels"), true);

const sheetRels = unzippedVault.get("xl/worksheets/_rels/sheet1.xml.rels") ?? "";
eq("first relationship target is Kasun Silva LinkedIn", sheetRels.includes('Target="https://www.linkedin.com/in/kasun-silva"'), true);
eq("second relationship target is Jane Doe LinkedIn", sheetRels.includes('Target="https://www.linkedin.com/in/jane-doe"'), true);
eq("relationship mode is External", sheetRels.includes('TargetMode="External"'), true);

const sheetXml = unzippedVault.get("xl/worksheets/sheet1.xml") ?? "";
eq("sheet has hyperlinks section", sheetXml.includes("<hyperlinks>"), true);
eq("first row LinkedIn cell G2 linked to rId1", sheetXml.includes('<hyperlink ref="G2" r:id="rId1"/>'), true);
eq("second row LinkedIn cell G3 linked to rId2", sheetXml.includes('<hyperlink ref="G3" r:id="rId2"/>'), true);
eq("G2 cell has hyperlink style s=2", sheetXml.includes('<c r="G2" t="inlineStr" s="2">'), true);
eq("A2 candidate name cell has default style s=0", sheetXml.includes('<c r="A2" t="inlineStr" s="0">'), true);

const stylesXml = unzippedVault.get("xl/styles.xml") ?? "";
eq("styles contains hyperlink blue color", stylesXml.includes('color rgb="FF0563C1"'), true);
eq("styles contains underline for hyperlink", stylesXml.includes("<u/>"), true);

const vaultHtml = toHtmlTable([...EXCEL_TABLES_EXPORT_HEADERS], exportRows);
eq("html table wraps LinkedIn URL in anchor tag", vaultHtml.includes('<a href="https://www.linkedin.com/in/kasun-silva"'), true);
eq("html anchor tag has blue underline styling", vaultHtml.includes('style="color:#0563c1;text-decoration:underline;"'), true);
eq("html table does not wrap non-URL cells in anchor tags", vaultHtml.includes('>Kasun Silva</td>'), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
