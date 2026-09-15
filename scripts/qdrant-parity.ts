/**
 * Which index does a vector made here actually match?
 *
 * There are two stores of candidate vectors and they were written by different
 * code at different times:
 *
 *   candidateResumes.embedding — written by matching/agent2, which asks
 *     OpenRouter or NVIDIA and then SLICES to 1,024.
 *   Qdrant `candidate_vectors` — written by matching/reindexVectors, which
 *     asks OpenAI for `dimensions: 1024`.
 *
 * Those are not the same space, and searching the wrong one returns confident
 * nonsense. This embeds a candidate's own text and compares it against both,
 * so the answer is measured rather than assumed.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/qdrant-parity.ts
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

const convex = (process.env.CONVEX_SELF_HOSTED_URL || "").replace(/\/+$/, "");
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "";
const qdrant = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/+$/, "");

async function cq<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${convex}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const b = (await res.json()) as { status: string; value: T; errorMessage?: string };
  if (b.status !== "success") throw new Error(b.errorMessage);
  return b.value;
}

const prep = (t: string) =>
  t.trim().slice(0, 15000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F�]/g, "").replace(/\s+/g, " ").trim();

console.log(`model: ${embedModel()}\n`);

// ── a few candidates that have a Qdrant vector ───────────────────────────────
const scroll = await fetch(`${qdrant}/collections/candidate_vectors/points/scroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ limit: 25, with_vector: true, with_payload: true }),
}).then((r) => r.json() as Promise<{ result: { points: { payload?: Record<string, unknown>; vector?: number[] }[] } }>);

const points = scroll.result.points.filter((p) => p.vector?.length === 1024 && p.payload?.candidateId);
console.log(`${points.length} Qdrant points sampled`);

let compared = 0, qdrantAgrees = 0, resumeAgrees = 0;
const qSims: number[] = [];
const rSims: number[] = [];

for (const p of points) {
  if (compared >= 4) break;
  const candidateId = String(p.payload!.candidateId);

  // The candidate's own CV text, and the other store's vector for them.
  const rows = await cq<{ candidateId: string; source: string; text: string | null }[]>(
    "ta/candidates:cvText",
    { candidateIds: [candidateId] },
  );
  const text = rows[0]?.text;
  if (!text || text.trim().length < 200) continue;

  const made = await embedTexts([prep(text)]);
  if (!made.ok) {
    console.log(`  could not embed — ${made.reason}`);
    break;
  }
  const mine = made.vectors[0];

  const qSim = cosine(mine, Float32Array.from(p.vector!));
  qSims.push(qSim);
  if (qSim > 0.97) qdrantAgrees++;

  compared++;
  console.log(`  ${String(p.payload!.fullName ?? "").slice(0, 26).padEnd(26)}  qdrant ${qSim.toFixed(4)}`);
}

// ── and against candidateResumes, for contrast ───────────────────────────────
const page = await cq<{ page: { rawText?: string; embedding?: number[] }[] }>(
  "matching/queries:getPaginatedResumesWithEmbeddings",
  { limit: 8, cursor: null },
);
for (const r of page.page.filter((x) => x.embedding?.length === 1024 && (x.rawText ?? "").length > 200).slice(0, 3)) {
  const made = await embedTexts([prep(r.rawText!)]);
  if (!made.ok) break;
  const s = cosine(made.vectors[0], Float32Array.from(r.embedding!));
  rSims.push(s);
  if (s > 0.97) resumeAgrees++;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

console.log(`\nQdrant            ${qdrantAgrees}/${qSims.length} agree   average ${avg(qSims).toFixed(4)}`);
console.log(`candidateResumes  ${resumeAgrees}/${rSims.length} agree   average ${avg(rSims).toFixed(4)}`);
console.log(
  `\nSearch must run against the store our queries match.` +
    (qdrantAgrees === qSims.length && qSims.length > 0
      ? " Qdrant agrees — that is the one."
      : " Neither agrees; the index has to be rebuilt with this model before search means anything."),
);
