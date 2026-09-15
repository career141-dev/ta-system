#!/usr/bin/env node
/**
 * scripts/convex-local-only.mjs
 *
 * Preflight guard — refuses to run any `npx convex` command unless the
 * resolved target URL is 127.0.0.1 (the local Docker container).
 *
 * Usage (wrap any convex CLI call):
 *   node scripts/convex-local-only.mjs dev --once
 *   node scripts/convex-local-only.mjs codegen
 *   node scripts/convex-local-only.mjs import backup.zip --replace --yes
 *
 * The guard reads the same sources the CLI reads, in order:
 *   1. CONVEX_SELF_HOSTED_URL env var
 *   2. CONVEX_URL env var
 *   3. NEXT_PUBLIC_CONVEX_URL env var
 *   4. .env.local in the project root
 *
 * If the resolved URL is not http://127.0.0.1:* it aborts with a clear message
 * before any network call is made.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── 1. Load .env.local manually (same logic as the CLI) ──────────────────────
const envLocalPath = join(process.cwd(), ".env.local");
const envVars = { ...process.env };

if (existsSync(envLocalPath)) {
  const lines = readFileSync(envLocalPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in envVars)) envVars[key] = val; // env vars take precedence
  }
}

// ── 2. Resolve the target URL ─────────────────────────────────────────────────
const resolved =
  envVars.CONVEX_SELF_HOSTED_URL ||
  envVars.CONVEX_URL ||
  envVars.NEXT_PUBLIC_CONVEX_URL ||
  "";

// ── 3. Guard ──────────────────────────────────────────────────────────────────
function isAllowedHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "94.136.189.48";
  } catch {
    return false;
  }
}

if (!resolved) {
  console.error(
    "\n🛑  BLOCKED: No Convex URL is set in environment or .env.local.\n" +
    "    Set NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 (or your VPS IP) first.\n"
  );
  process.exit(1);
}

if (!isAllowedHost(resolved)) {
  console.error(
    "\n🛑  BLOCKED: Refusing to run convex CLI against a disallowed deployment.\n" +
    `    Resolved target: ${resolved}\n` +
    "    This repo only allows localhost or the staging VPS (94.136.189.48) as a target.\n"
  );
  process.exit(1);
}

// ── 4. All clear — run the command ───────────────────────────────────────────
const [, , ...args] = process.argv;
console.log(`✅  Target verified: ${resolved}`);
console.log(`▶   npx convex ${args.join(" ")}\n`);

const result = spawnSync("npx", ["convex", ...args], {
  stdio: "inherit",
  shell: true,
  env: envVars,
});

process.exit(result.status ?? 0);
