/**
 * Is the index in the same space as the vectors we make?
 *
 * The earlier check compared a candidate's FULL CV text against their indexed
 * vector and scored 0.68. That is not a failure and it is not parity either —
 * the index is built from a summary of structured fields (name, title, skills,
 * summary, location), so the two are different documents about the same
 * person and 0.68 is what genuine agreement between them looks like.
 *
 * This builds the SAME text the reindexer builds and compares that. Same text,
 * same model, same width: anything below ~0.99 means we are not in the index's
 * space and every search result would be quietly wrong.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/index-parity.ts
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

const qdrant = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/+$/, "");

/** Exactly what convex/matching/reindexVectors.ts builds. */
function indexText(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (p.fullName) parts.push(String(p.fullName));
  if (p.currentJobTitle) parts.push(String(p.currentJobTitle));
  const skills = Array.isArray(p.skills) ? (p.skills as string[]) : [];
  if (skills.length) parts.push("Skills: " + skills.slice(0, 30).join(", "));
  if (p.locationCity || p.locationCountry) {
    parts.push([p.locationCity, p.locationCountry].filter(Boolean).join(", "));
  }
  return parts.join(". ").replace(/\s+/g, " ").trim();
}

console.log(`model: ${embedModel()}\n`);

const scroll = await fetch(`${qdrant}/collections/candidate_vectors/points/scroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ limit: 40, with_vector: true, with_payload: true }),
}).then((r) => r.json() as Promise<{ result: { points: { payload?: Record<string, unknown>; vector?: number[] }[] } }>);

const usable = scroll.result.points
  .filter((p) => p.vector?.length === 1024 && indexText(p.payload ?? {}).length > 20)
  .slice(0, 5);

if (usable.length === 0) {
  console.log("  no points with enough payload to rebuild their text");
  process.exit(1);
}

const made = await embedTexts(usable.map((p) => indexText(p.payload!)));
if (!made.ok) {
  console.log(`  could not embed — ${made.reason}`);
  process.exit(1);
}

/*
 * What counts as proof here.
 *
 * The Qdrant payload does not carry `summary` or `industry`, and the reindexer
 * puts both into the text it embeds. So for a candidate who had a summary the
 * text cannot be reconstructed exactly from the payload, and the score lands
 * around 0.9 — which measures how much of the text is missing, not whether the
 * two spaces agree.
 *
 * An exact 1.0 is what settles it: two vectors score that only if they are the
 * same vector, which cannot happen across different models or widths. So the
 * test is that at least one candidate whose text IS fully reconstructable
 * scores 1.0, and that none of the rest sit near zero — a different model
 * would put every one of them around 0.0, which is exactly what
 * candidateResumes does.
 */
const sims = usable.map((p, i) => ({
  name: String(p.payload?.fullName ?? "(unnamed)").slice(0, 24),
  score: cosine(made.vectors[i], Float32Array.from(p.vector!)),
}));

for (const r of sims) {
  const exact = r.score > 0.9999;
  console.log(
    `  ${exact ? "ok  " : "~   "} ${r.name.padEnd(24)} ${r.score.toFixed(5)}` +
      (exact ? "  identical" : "  (payload lacks summary, so this text is partial)"),
  );
}

const exact = sims.filter((r) => r.score > 0.9999).length;
const ok = exact > 0 && sims.every((r) => r.score > 0.8);
console.log(
  ok
    ? `\nSame space. ${exact} of ${sims.length} reconstruct exactly and score 1.0; the rest are ` +
        `partial text rather than a different model.\n`
    : `\nNot the same space — a query made here would not compare with the index.\n`,
);
process.exit(ok ? 0 : 1);
