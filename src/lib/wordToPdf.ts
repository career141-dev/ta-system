import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A Word CV as a PDF, so it opens in the same viewer as every other CV.
 *
 * Browsers cannot show .doc or .docx, so a Word CV could only be downloaded
 * and opened outside the app (25 Sep). The owner wanted the CV as it really
 * looks, not re-typeset, so LibreOffice (installed in the app image — see the
 * Dockerfile) converts it on the server. The original file is untouched;
 * Download still gives the Word file.
 *
 * Cached by the file's own hash in the system temp folder — /app/.data is not
 * writable on live — so the second open is instant.
 *
 * ponytail: one conversion at a time (LibreOffice shares one profile) and the
 * cache is never pruned; it empties when the container restarts. Add a pool or
 * a size cap if people open hundreds of Word CVs a day.
 */

const SOFFICE = process.env.SOFFICE_PATH || "soffice";
const CACHE = path.join(os.tmpdir(), "c141-cv-pdf");
const PROFILE = pathToFileURL(path.join(os.tmpdir(), "c141-lo-profile")).href;

export function isWordFile(fileName: string | null | undefined): boolean {
  return /\.(docx?|rtf|odt)$/i.test(fileName ?? "");
}

let queue: Promise<unknown> = Promise.resolve();

export async function wordToPdf(bytes: Buffer, fileName: string): Promise<Buffer> {
  const cached = path.join(CACHE, `${createHash("sha256").update(bytes).digest("hex")}.pdf`);
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;
  const run = queue.then(() => convert(bytes, fileName, cached));
  queue = run.catch(() => undefined);
  return run;
}

async function convert(bytes: Buffer, fileName: string, cached: string): Promise<Buffer> {
  // The same file may have been converted while this one waited its turn.
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;
  const dir = await mkdtemp(path.join(os.tmpdir(), "c141-cv-"));
  try {
    const ext = fileName.match(/\.([a-z]{2,4})$/i)?.[1]?.toLowerCase() ?? "docx";
    const source = path.join(dir, `cv.${ext}`);
    await writeFile(source, bytes);
    await new Promise<void>((resolve, reject) =>
      execFile(
        SOFFICE,
        ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${PROFILE}`, "--convert-to", "pdf", "--outdir", dir, source],
        { timeout: 60_000 },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    const pdf = await readFile(path.join(dir, "cv.pdf"));
    await mkdir(CACHE, { recursive: true });
    await writeFile(cached, pdf);
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
