import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks", "--no-warnings", "--import", "./tests/alias.mjs", "tests/fixtures/search-engine.mjs"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", env: { ...process.env, C141_STORE: "json", C141_TEST_RUN: "1" }, timeout: 60_000,
});
console.log(run.stdout);
if (run.stderr) console.error(run.stderr);
assert.equal(run.status, 0, run.error?.message ?? "Search engine integration regression");
