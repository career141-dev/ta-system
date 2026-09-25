/**
 * The bulk CV download's ZIP (lib/zip): readable back, file for file, and
 * named after the people in it.
 */
import { crc32 } from "node:zlib";
import { cvFileName, zipStore } from "@/lib/zip";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

/** Reads a ZIP the way an unzip tool does: from the central directory at the end. */
function unzip(buf: Buffer) {
  const end = buf.length - 22;
  eq("ends with the end-of-directory record", buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: { name: string; data: string; crcOk: boolean; utf8: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const local = buf.readUInt32LE(at + 42);
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    out.push({ name, data: data.toString("utf8"), crcOk: crc32(data) === crc, utf8: (buf.readUInt16LE(at + 8) & 0x0800) !== 0 });
    at += 46 + nameLen;
  }
  return out;
}

console.log("\nzip");
const zip = zipStore([
  { name: "John Smith.pdf", data: Buffer.from("%PDF-1.4 john") },
  { name: "Sébastien Perera.docx", data: Buffer.from("word bytes") },
  { name: "Empty.pdf", data: new Uint8Array() },
]);
const files = unzip(zip);
eq("three files", files.length, 3);
eq("names kept, accents too", files.map((f) => f.name), ["John Smith.pdf", "Sébastien Perera.docx", "Empty.pdf"]);
eq("contents kept", files.map((f) => f.data), ["%PDF-1.4 john", "word bytes", ""]);
eq("every checksum matches", files.every((f) => f.crcOk), true);
eq("names marked UTF-8", files.every((f) => f.utf8), true);
eq("starts with a local header", zip.readUInt32LE(0), 0x04034b50);

console.log("\nfile names");
const used = new Set<string>();
eq("the person's exact name", cvFileName("John Smith", "cv_final_v3.PDF", used), "John Smith.pdf");
eq("Word keeps its extension", cvFileName("David Perera", "david.docx", used), "David Perera.docx");
eq("a second John Smith", cvFileName("John Smith", "x.pdf", used), "John Smith (2).pdf");
eq("same name, other case, still a repeat", cvFileName("JOHN SMITH", "x.pdf", used), "JOHN SMITH (3).pdf");
eq("characters Windows refuses are removed", cvFileName('A/B: "C"?', "x.pdf", used), "A B C.pdf");
eq("no name falls back", cvFileName("  ", null, used), "Candidate.pdf");
eq("no trailing dot", cvFileName("Jr.", "x.pdf", used), "Jr.pdf");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
