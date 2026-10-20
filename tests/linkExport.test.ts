/**
 * Tests for Excel Tables export helper and EOD email attachment builder (lib/linkExport).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-linkexport-"));
process.chdir(tmp);

const { repo } = await import("@/data/store");
const { buildOpeningExcelAttachment, getScopedLinkVaultEntries, formatExportRowsForEntries } = await import("@/lib/linkExport");
import type { LinkVaultEntry, User } from "@/data/types";

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
eq("first row company", ta1Rows[0][2], "Apex Tech");
eq("first row LinkedIn URL", ta1Rows[0][6], "https://www.linkedin.com/in/candidate-one");
eq("first row sheet level", ta1Rows[0][7], "L1");
eq("first row notes carries lead note", ta1Rows[0][12], "Strong systems design background");

console.log("\n4. Build Excel attachment with OpenXML hyperlinks");
const attachment = buildOpeningExcelAttachment(opening.id, ta1, opening.title);
eq("attachment is returned", attachment !== null, true);
if (attachment) {
  eq("contentType is OpenXML spreadsheet", attachment.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const stamp = new Date().toISOString().slice(0, 10);
  const safeTitle = opening.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  eq("filename has correct pattern", attachment.filename, `career141-${safeTitle}-excel-tables-${stamp}.xlsx`);
  eq("base64 is valid encoding of buffer", attachment.base64, attachment.buffer.toString("base64"));
  eq("rowCount is positive", attachment.rowCount > 0, true);

  const files = unzipFiles(attachment.buffer);
  eq("workbook has worksheet", files.has("xl/worksheets/sheet1.xml"), true);
  eq("worksheet rels exists for hyperlinks", files.has("xl/worksheets/_rels/sheet1.xml.rels"), true);

  const relsXml = files.get("xl/worksheets/_rels/sheet1.xml.rels") || "";
  eq("rels XML contains LinkedIn hyperlink relationship", relsXml.includes("https://www.linkedin.com/in/candidate-one"), true);
  eq("relationship has type Hyperlink", relsXml.includes("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"), true);

  const sheetXml = files.get("xl/worksheets/sheet1.xml") || "";
  eq("sheet XML contains <hyperlinks> element", sheetXml.includes("<hyperlinks>"), true);
  eq("sheet XML links cell G", sheetXml.includes('ref="G'), true);

  const stylesXml = files.get("xl/styles.xml") || "";
  eq("styles contains hyperlink blue color #0563C1", stylesXml.includes('rgb="FF0563C1"'), true);
  eq("styles contains underline", stylesXml.includes("<u/>"), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
