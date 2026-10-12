/**
 * Tests for Excel (.xlsx) builder and clipboard formatters (lib/xlsx).
 */
import { buildXlsx, toTsv, toHtmlTable, formatLinkVaultExportRows, EXCEL_TABLES_EXPORT_HEADERS } from "@/lib/xlsx";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
