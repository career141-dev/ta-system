import "server-only";
import { spawn } from "node:child_process";
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
 * Two at a time, each with its own LibreOffice profile (1 Oct). It was one at
 * a time for the whole office: one TA's end-of-day email, converting every
 * Word CV it attached, held another TA's CV preview blank until it finished.
 * The same file asked for twice at once is converted once. A conversion that
 * runs past 60 seconds is killed with everything it started — LibreOffice's
 * worker outlived its launcher and held the shared profile, failing the next.
 *
 * ponytail: the cache is never pruned; it empties when the container restarts.
 * SOFFICE_SLOTS raises the two if many Word CVs are opened at once.
 */

const SOFFICE = process.env.SOFFICE_PATH || "soffice";
const CACHE = path.join(os.tmpdir(), "c141-cv-pdf");
const SLOTS = Math.max(1, Number(process.env.SOFFICE_SLOTS) || 2);
const TIMEOUT_MS = 60_000;
const profile = (slot: number) => pathToFileURL(path.join(os.tmpdir(), `c141-lo-profile-${slot}`)).href;

export function isWordFile(fileName: string | null | undefined): boolean {
  return /\.(docx?|rtf|odt)$/i.test(fileName ?? "");
}

const free: number[] = Array.from({ length: SLOTS }, (_, i) => i);
const waiting: ((slot: number) => void)[] = [];
const inFlight = new Map<string, Promise<Buffer>>();

function takeSlot(): Promise<number> {
  const slot = free.pop();
  return slot !== undefined ? Promise.resolve(slot) : new Promise((resolve) => waiting.push(resolve));
}

function giveSlot(slot: number) {
  const next = waiting.shift();
  if (next) next(slot);
  else free.push(slot);
}

export async function wordToPdf(bytes: Buffer, fileName: string): Promise<Buffer> {
  const key = createHash("sha256").update(bytes).digest("hex");
  const cached = path.join(CACHE, `${key}.pdf`);
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const slot = await takeSlot();
    try {
      return await convert(bytes, fileName, cached, slot);
    } finally {
      giveSlot(slot);
    }
  })();
  inFlight.set(key, run);
  run.finally(() => inFlight.delete(key)).catch(() => undefined);
  return run;
}

async function convert(bytes: Buffer, fileName: string, cached: string, slot: number): Promise<Buffer> {
  // The same file may have been converted while this one waited its turn.
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;
  const dir = await mkdtemp(path.join(os.tmpdir(), "c141-cv-"));
  try {
    const ext = fileName.match(/\.([a-z]{2,4})$/i)?.[1]?.toLowerCase() ?? "docx";
    const source = path.join(dir, `cv.${ext}`);
    await writeFile(source, bytes);
    await soffice(["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${profile(slot)}`, "--convert-to", "pdf", "--outdir", dir, source]);
    const pdf = await readFile(path.join(dir, "cv.pdf"));
    await mkdir(CACHE, { recursive: true });
    await writeFile(cached, pdf);
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run LibreOffice in its own process group, so a timeout kills its worker too. */
function soffice(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE, args, { detached: process.platform !== "win32", stdio: "ignore" });
    const timer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`LibreOffice took over ${TIMEOUT_MS / 1000} seconds`));
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice stopped with code ${code}`));
    });
  });
}
