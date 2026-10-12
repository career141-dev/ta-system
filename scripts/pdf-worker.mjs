import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Copy the worker from the same installation as the browser API (12 Oct).
 * A versioned URL also keeps browsers from reusing a previous release's worker.
 */
export function syncPdfWorker(root) {
  const packageDir = path.join(root, "node_modules/pdfjs-dist");
  const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const destination = path.join(root, "public/pdfjs", version);
  mkdirSync(destination, { recursive: true });
  copyFileSync(path.join(packageDir, "build/pdf.worker.min.mjs"), path.join(destination, "pdf.worker.min.mjs"));
}
