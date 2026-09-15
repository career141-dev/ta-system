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
// Pass cwd-relative POSIX-style paths. Absolute Windows paths ("C:\\…") break
// `--import` ("c:" parses as a URL protocol) and absolute file:// URLs get
// mangled when the command runs through MSYS/Git Bash. "./tests/x.ts" is safe
// everywhere because spawnSync sets cwd to the project root.
const rel = (p) => "./" + path.relative(path.resolve(here, ".."), p).split(path.sep).join("/");
for (const file of files) {
  const label = file.replace(".test.ts", "");
  process.stdout.write(`\n== ${label} ${"=".repeat(Math.max(0, 60 - label.length))}\n`);
  const r = spawnSync(
    process.execPath,
    // Node 22 only loads .ts files with the flag (23.6+ does it by default and
    // still accepts it), so without it every suite failed before running.
    ["--experimental-strip-types", "--no-warnings", "--import", rel(path.join(here, "alias.mjs")), rel(path.join(here, file))],
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
