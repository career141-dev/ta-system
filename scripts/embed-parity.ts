/**
 * Does a vector made HERE land in the same space as the ones already indexed?
 *
 * This is the check the whole of search rests on, and it cannot be done by
 * reading code. `text-embedding-3-small` returns 1,536 numbers. Asking it for
 * 1,024 (`dimensions: 1024`) truncates and RE-NORMALISES; taking the first
 * 1,024 yourself does not. Both give you a 1,024-long array, both look
 * plausible, and only one of them compares with the index.
 *
 * So: take a CV whose vector is already stored, embed its text again the way
 * this platform now does it, and compare. Near 1.0 means the two agree. Near
 * 0.8 means we are in a different space and every search result is wrong.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/embed-parity.ts
 */

import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}

import { cosine, embedModel, embedTexts } from "@/lib/embed";

const url = (process.env.CONVEX_SELF_HOSTED_URL || process.env.CONVEX_URL || "").replace(/\/+$/, "");
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "";

async function q<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${url}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const body = (await res.json()) as { status: string; value: T; errorMessage?: string };
  if (body.status !== "success") throw new Error(body.errorMessage);
  return body.value;
}

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

console.log(`model: ${embedModel()}\n`);

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// ── the stored vectors ───────────────────────────────────────────────────────
const page = await q<{ page: { rawText?: string; embedding?: number[] }[] }>(
  "matching/queries:getPaginatedResumesWithEmbeddings",
  { limit: 12, cursor: null },
);
const withText = page.page.filter((r) => r.embedding?.length && (r.rawText ?? "").trim().length > 200).slice(0, 4);
check("found CVs with both text and a stored vector", withText.length > 0, `${withText.length}`);

console.log("\nthe stored vectors");
for (const r of withText.slice(0, 2)) {
  check(`width ${r.embedding!.length}`, r.embedding!.length === 1024, "");
  check(`unit length (${norm(r.embedding!).toFixed(4)})`, Math.abs(norm(r.embedding!) - 1) < 0.01,
    "a re-normalised vector measures 1.0; a sliced one about 0.82");
}

// ── ours, made the same way the live path makes them ─────────────────────────
console.log("\nours against theirs");
// Same preparation the old system used before embedding: first 15,000
// characters, control characters stripped, whitespace collapsed.
const prep = (t: string) =>
  t.trim().slice(0, 15000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F�]/g, "").replace(/\s+/g, " ").trim();

const made = await embedTexts(withText.map((r) => prep(r.rawText!)));
if (!made.ok) {
  console.log(`  FAIL could not embed — ${made.reason}`);
  process.exit(1);
}

check("we produce 1,024 numbers", made.vectors.every((v) => v.length === 1024), "");
check(
  "ours are unit length",
  made.vectors.every((v) => Math.abs(norm([...v]) - 1) < 0.01),
  made.vectors.map((v) => norm([...v]).toFixed(4)).join(", "),
);

const sims = withText.map((r, i) => cosine(made.vectors[i], Float32Array.from(r.embedding!)));
for (const [i, s] of sims.entries()) {
  check(`CV ${i + 1} similarity ${s.toFixed(4)}`, s > 0.97,
    s > 0.97 ? "same space" : "DIFFERENT SPACE — searches would return the wrong people");
}

console.log(failed === 0 ? "\nParity confirmed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed ? 1 : 0);
