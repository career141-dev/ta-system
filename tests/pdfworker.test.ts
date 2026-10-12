import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncPdfWorker } from "../scripts/pdf-worker.mjs";

// Reproduce an upgrade without installing packages or touching candidate data.
const root = mkdtempSync(path.join(os.tmpdir(), "ta-pdf-worker-"));
try {
  const packageDir = path.join(root, "node_modules/pdfjs-dist");
  mkdirSync(path.join(packageDir, "build"), { recursive: true });
  for (const version of ["5.7.284", "6.4.299"]) {
    writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version }));
    const worker = `// worker for ${version}\n`;
    writeFileSync(path.join(packageDir, "build/pdf.worker.min.mjs"), worker);
    syncPdfWorker(root);
    assert.equal(readFileSync(path.join(root, "public/pdfjs", version, "pdf.worker.min.mjs"), "utf8"), worker);
  }
  // A repeated build also replaces an incorrect file at the current URL.
  const current = path.join(root, "public/pdfjs/6.4.299/pdf.worker.min.mjs");
  writeFileSync(current, "stale worker");
  syncPdfWorker(root);
  assert.equal(readFileSync(current, "utf8"), "// worker for 6.4.299\n");
  console.log("  ok  worker follows the installed API across upgrades and rebuilds");
} finally {
  rmSync(root, { recursive: true, force: true });
}
