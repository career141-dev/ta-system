/**
 * Tests for Excel Tables export helper and EOD email attachment builder (lib/linkExport).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-linkexport-"));
process.chdir(tmp);

const { repo } = await import("@/data/store");
const { buildOpeningExcelAttachment, getScopedLinkVaultEntries, formatExportRowsForEntries, buildLinkExportLayout } = await import("@/lib/linkExport");
import type { LinkVaultEntry, User } from "@/data/types";
import { buildXlsx } from "@/lib/xlsx";

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

repo.reset();

const ta1: User = { id: "u_ta1", name: "Dilshan Perera", email: "dilshan@career141.com", role: "ta", isActive: true, phone: null, routingEmail: null, initials: "DP" };
const ta2: User = { id: "u_ta2", name: "Kasun Silva", email: "kasun@career141.com", role: "ta", isActive: true, phone: null, routingEmail: null, initials: "KS" };
const lead: User = { id: "u_lead", name: "Suresh Fernando", email: "suresh@career141.com", role: "ta_lead", isActive: true, phone: null, routingEmail: null, initials: "SF" };
const director: User = { id: "u_director", name: "Azim", email: "azim@career141.com", role: "director", isActive: true, phone: null, routingEmail: null, initials: "A" };

// Register users in store
const users = repo.users();
if (!users.find((u) => u.id === ta1.id)) users.push(ta1);
if (!users.find((u) => u.id === ta2.id)) users.push(ta2);
if (!users.find((u) => u.id === lead.id)) users.push(lead);
if (!users.find((u) => u.id === director.id)) users.push(director);

const opening = repo.openings()[0];
const emptyOpening = repo.openings().find((o) => repo.linkVault(o.id).length === 0) ?? repo.openings()[1];

console.log("\n1. Zero links behavior");
// Find or create an opening with 0 links
const zeroOpeningId = "op_empty_test";
const zeroAttachment = buildOpeningExcelAttachment(zeroOpeningId, ta1, "Empty Job");
eq("returns null when opening has 0 links", zeroAttachment, null);

console.log("\n2. Scoped links resolution");
// Seed test links on opening
const dummyLink1: LinkVaultEntry = {
  id: "lv_test_1",
  openingId: opening.id,
  addedBy: ta1.id,
  linkedinUrl: "https://www.linkedin.com/in/candidate-one",
  name: "Candidate One",
  title: "Senior Backend Engineer",
  company: "Apex Tech",
  phoneNumber: "+94771112222",
  phoneSource: "other",
  level: 1,
  isAddOn: false,
  isEyeMarked: false,
  sourcingChannel: "L",
  candidateId: null,
  outcome: "shortlisted",
  createdAt: Date.now() - 3600000,
  leadNotes: [{ id: "ln_1", by: lead.id, byRole: "ta_lead", at: Date.now() - 1000, note: "Strong systems design background" }],
  conversationLog: [],
};

const dummyLink2: LinkVaultEntry = {
  id: "lv_test_2",
  openingId: opening.id,
  addedBy: ta2.id, // Added by another TA
  linkedinUrl: "https://www.linkedin.com/in/candidate-two",
  name: "Candidate Two",
  title: "Frontend Architect",
  company: "Web Innovations",
  phoneNumber: "+94773334444",
  phoneSource: "profile",
  level: 2,
  isAddOn: true,
  isEyeMarked: true,
  sourcingChannel: "L",
  candidateId: null,
  outcome: "shortlisted",
  createdAt: Date.now() - 7200000,
  leadNotes: [],
  conversationLog: [{ at: Date.now() - 500, note: "Approached via InMail", channel: "linkedin", by: ta2.id }],
};

const dummyLink3: LinkVaultEntry = {
  id: "lv_test_3",
  openingId: opening.id,
  addedBy: lead.id, // Added by desk-wide lead
  linkedinUrl: "https://www.linkedin.com/in/candidate-three",
  name: "Candidate Three",
  title: "DevOps Lead",
  company: "CloudScale",
  phoneNumber: null,
  phoneSource: null,
  level: null,
  isAddOn: false,
  isEyeMarked: false,
  sourcingChannel: "L",
  candidateId: null,
  outcome: "shortlisted",
  createdAt: Date.now() - 10800000,
  leadNotes: [],
  conversationLog: [],
};

// Insert into store db.json
const dbFile = path.join(tmp, ".data", "db.json");
const db = JSON.parse(fs.readFileSync(dbFile, "utf8"));
db.users.push(...[ta1, ta2, lead, director].filter(u => !db.users.some((saved: User) => saved.id === u.id)));
db.linkVault.push(dummyLink1, dummyLink2, dummyLink3);
// Wait a few ms so mtime changes
const futureTime = new Date(Date.now() + 2000);
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.utimesSync(dbFile, futureTime, futureTime);

const ta1Scoped = getScopedLinkVaultEntries(opening.id, ta1);
eq("TA1 sees own links + lead-shared links, but not TA2 links", ta1Scoped.entries.map((e) => e.id).filter((id) => id.startsWith("lv_test_")), ["lv_test_1", "lv_test_3"]);

const directorScoped = getScopedLinkVaultEntries(opening.id, director);
eq("Director sees all links including TA1, TA2, and Lead", directorScoped.entries.filter((e) => e.id.startsWith("lv_test_")).length, 3);

console.log("\n3. Format rows & note extraction");
const ta1Rows = formatExportRowsForEntries(ta1Scoped.entries.filter((e) => e.id.startsWith("lv_test_")), ta1Scoped.facts, ta1Scoped.userNames, ta1Scoped.canSeeLeadNotes);
eq("formats expected row count for TA1", ta1Rows.length, 2);
eq("first row candidate name", ta1Rows[0][0], "Candidate One");
eq("first row LinkedIn URL", ta1Rows[0][1], "https://www.linkedin.com/in/candidate-one");
eq("Shortlisted alone is still Pending", ta1Rows[0][2], "Pending");
eq("first row notes carries lead note", ta1Rows[0][3], "Strong systems design background");

console.log("\n4. Build Excel attachment with OpenXML hyperlinks");
const attachment = buildOpeningExcelAttachment(opening.id, ta1, opening.title);
eq("attachment is returned", attachment !== null, true);
if (attachment) {
  eq("contentType is OpenXML spreadsheet", attachment.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const stamp = new Date().toISOString().slice(0, 10);
  const { excelFilename } = await import("@/lib/excelFilename");
  eq("filename has correct pattern", attachment.filename, excelFilename(repo.client(opening.clientId)?.name || "Client", opening.title, undefined, new Date(stamp)));
  eq("base64 is valid encoding of buffer", attachment.base64, attachment.buffer.toString("base64"));
  eq("rowCount is positive", attachment.rowCount > 0, true);

  const files = unzipFiles(attachment.buffer);
  eq("workbook has worksheet", files.has("xl/worksheets/sheet1.xml"), true);
  eq("worksheet rels exists for hyperlinks", files.has("xl/worksheets/_rels/sheet1.xml.rels"), true);

  const relsXml = [...files].filter(([name]) => /^xl\/worksheets\/_rels\//.test(name)).map(([, xml]) => xml).join("");
  eq("rels XML contains LinkedIn hyperlink relationship", relsXml.includes("https://www.linkedin.com/in/candidate-one"), true);
  eq("relationship has type Hyperlink", relsXml.includes("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"), true);

  const sheetXml = files.get("xl/worksheets/sheet1.xml") || "";
  eq("sheet XML contains <hyperlinks> element", sheetXml.includes("<hyperlinks>"), true);
  eq("sheet XML links cell B", sheetXml.includes('ref="B'), true);

  const stylesXml = files.get("xl/styles.xml") || "";
  eq("styles contains hyperlink blue color #0563C1", stylesXml.includes('rgb="FF0563C1"'), true);
  eq("styles contains underline", stylesXml.includes("<u/>"), true);
}

console.log("\n5. Separate TAs, levels and interest sections");
const entries = [
  { ...dummyLink1, id: "z", name: "Zed", level: 1 },
  { ...dummyLink1, id: "a", name: "Alice", level: 1 },
  { ...dummyLink1, id: "b", name: "Bob", level: 1 },
  { ...dummyLink1, id: "n", name: "No", level: 1, outcome: "declined" as const },
  { ...dummyLink1, id: "l2", level: 2 },
  { ...dummyLink1, id: "l10", level: 10 },
  { ...dummyLink2, id: "other", level: 1 },
  { ...dummyLink3, id: "unassigned", level: null },
];
const facts = new Map(entries.map(e => [e.id, { app: null, interest: e.id === "n" ? "not_interested" : ["a", "b"].includes(e.id) ? "interested" : "pending" }]));
const names = { [ta1.id]: "Dilshan Perera", [ta2.id]: "Kasun Silva", [lead.id]: "Suresh Fernando" };
const layout = buildLinkExportLayout(entries, facts, names, true);
eq("TA levels sorted numerically and unassigned retained", layout.sheets.map(s => s.name), ["Dilshan Perera L1", "Dilshan Perera L2", "Dilshan Perera L10", "Kasun Silva L1", "Suresh Fernando Unassigned"]);
const first = layout.sheets[0];
eq("status sections in agreed order", first.sectionRows!.map(i => first.rows[i][0]), ["Interested", "Pending", "Not Interested"]);
eq("each candidate appears once in correct group", first.rows.filter(r => r[1]).map(r => [r[0], r[2]]), [["Alice", "Interested"], ["Bob", "Interested"], ["Zed", "Pending"], ["No", "Not Interested"]]);
eq("candidate count excludes headings and spacers", layout.rowCount, entries.length);
eq("clipboard preserves TA/level labels", layout.clipboardRows.filter(r => r[0] === "Kasun Silva L1").length, 1);
eq("only four columns in every row", layout.sheets.every(s => s.rows.every(r => r.length === 4)), true);
eq("input records not changed", entries.map(e => e.id), ["z", "a", "b", "n", "l2", "l10", "other", "unassigned"]);
eq("empty export has one header-only sheet", buildLinkExportLayout([], new Map(), names, true).sheets, [{ name: "Excel Tables", headers: ["Candidate Name", "Links", "Status", "Notes"], rows: [] }]);
const own = getScopedLinkVaultEntries(opening.id, ta1);
const ownLayout = buildLinkExportLayout(own.entries, own.facts, own.userNames, own.canSeeLeadNotes);
eq("other TA's link absent after grouping", ownLayout.sheets.flatMap(s => s.rows).some(r => r[1] === dummyLink2.linkedinUrl), false);
// ZIP timestamps can differ between calls; compare workbook parts instead.
if (attachment) eq("email and download builder produce same workbook parts", [...unzipFiles(attachment.buffer)], [...unzipFiles(buildXlsx({ sheets: ownLayout.sheets }))]);

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
