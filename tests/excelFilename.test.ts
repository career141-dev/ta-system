import assert from "node:assert/strict";
import { excelFilename, excelDownloadDisposition } from "@/lib/excelFilename";

const date = new Date("2026-10-21T10:00:00Z");
assert.equal(excelFilename("BRANDIX INDIA", "Engineering Manager", "Mumbai", date), "BRANDIX INDIA - Engineering Manager - Mumbai - 2026-10-21.xlsx");
assert.equal(excelFilename("BRANDIX INDIA", "Engineering Manager", "Delhi", date), "BRANDIX INDIA - Engineering Manager - Delhi - 2026-10-21.xlsx");
assert.equal(excelFilename("BRANDIX INDIA", "Engineering Manager", undefined, date), "BRANDIX INDIA - Engineering Manager - 2026-10-21.xlsx");
assert.equal(excelFilename(' A/B\r\n"Client" ', 'Manager: R&D?', " Mumbai. ", date), "A B Client - Manager R&D - Mumbai - 2026-10-21.xlsx");
assert.equal(excelFilename("", " ", " ", date), "Client - Position - 2026-10-21.xlsx");
const unicode = excelFilename("සිංහල", "Manager", "Delhi", date);
assert.ok(unicode.startsWith("සිංහල - Manager"));
const disposition = excelDownloadDisposition(unicode);
assert.ok(disposition.includes("filename*=UTF-8''" + encodeURIComponent(unicode)));
assert.doesNotThrow(() => new Headers({ "Content-Disposition": disposition }));
assert.ok(excelFilename("a".repeat(500), "b".repeat(500), "c".repeat(500), date).length < 220);
console.log("Excel filename tests passed.");
