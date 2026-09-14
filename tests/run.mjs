/**
 * Runs every `*.test.ts` in this directory and reports the total.
 *
 * Each file is its own process, so one crash cannot take the suite with it and
 * a module's global state cannot leak into the next file's expectations.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2] ?? "";
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !only || f.includes(only))
  .sort();

let failed = 0;
const bad = [];
for (const file of files) {
  const label = file.replace(".test.ts", "");
  process.stdout.write(`\n== ${label} ${"=".repeat(Math.max(0, 60 - label.length))}\n`);
  const r = spawnSync(
    process.execPath,
    ["--import", path.join(here, "alias.mjs"), path.join(here, file)],
    { stdio: "inherit", cwd: path.resolve(here, "..") },
  );
  if (r.status !== 0) { failed++; bad.push(label); }
}

process.stdout.write(
  failed === 0
    ? `\nAll ${files.length} suites passed.\n`
    : `\n${failed} of ${files.length} suites failed: ${bad.join(", ")}\n`,
);
process.exit(failed ? 1 : 0);
