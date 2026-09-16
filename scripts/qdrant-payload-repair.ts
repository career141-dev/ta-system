/**
 * Rewrite the payload of every point already in Qdrant, without re-embedding.
 *
 * The vector writers read `candidate.locationCity` / `locationCountry`, which
 * the candidates table does not have, so every point carried empty place
 * fields and the engine's location-filtered vector search returned nothing.
 * The writers are fixed (convex/lib/vectorPayload.ts); this brings the points
 * written before the fix into line. Vectors are left exactly as they are.
 *
 * Only points that already exist are touched — a candidate with no vector is
 * the reindexer's business, not this script's. Local Qdrant only.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/qdrant-payload-repair.ts [--dry]
 */
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}

const { convexQuery } = await import("@/lib/convexServer");

const qdrant = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/+$/, "");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(qdrant)) {
  throw new Error(`Refusing to write to ${qdrant}: this script only touches a Qdrant on this machine.`);
}
const COLLECTION = "candidate_vectors";
const dry = process.argv.includes("--dry");
const maxPages = Number(process.argv[process.argv.indexOf("--pages") + 1]) || Infinity;

async function q(path: string, body: unknown) {
  const res = await fetch(`${qdrant}/collections/${COLLECTION}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as { status?: unknown; result?: unknown };
  if (!res.ok) throw new Error(`Qdrant ${path}: HTTP ${res.status} ${JSON.stringify(json.status)}`);
  return json.result;
}

// The text index the location filter needs. Creating one that exists is a no-op.
if (!dry) {
  await fetch(`${qdrant}/collections/${COLLECTION}/index?wait=true`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      field_name: "location",
      field_schema: { type: "text", tokenizer: "word", lowercase: true, min_token_len: 2 },
    }),
  });
}

type Page = { points: { pointId: string; payload: Record<string, unknown> }[]; isDone: boolean; continueCursor: string | null };

let cursor: string | null = null;
let seen = 0;
let updated = 0;
let withPlace = 0;
let pages = 0;
const started = Date.now();

for (;;) {
  const page: Page = await convexQuery<Page>("ta/candidates:vectorPayloadPage", { cursor, numItems: 400 });
  pages++;
  seen += page.points.length;

  const ids = page.points.map((p) => p.pointId);
  const existing = new Set(
    ((await q("/points", { ids, with_payload: false, with_vector: false })) as { id: string }[]).map((p) => String(p.id)),
  );
  const present = page.points.filter((p) => existing.has(p.pointId));
  withPlace += present.filter((p) => String(p.payload.location ?? "").length > 0).length;

  if (!dry && present.length > 0) {
    const operations = present.flatMap((p) => {
      const ops: unknown[] = [{ set_payload: { payload: p.payload, points: [p.pointId] } }];
      // Unknown experience is absent, not 0 — remove the 0 the old writer left.
      if (p.payload.totalExperienceYears === undefined) {
        ops.push({ delete_payload: { keys: ["totalExperienceYears"], points: [p.pointId] } });
      }
      return ops;
    });
    await q("/points/batch?wait=true", { operations });
  }
  updated += present.length;

  if (pages % 20 === 0 || page.isDone || pages >= maxPages) {
    console.log(`  ${seen.toLocaleString()} candidates read, ${updated.toLocaleString()} points ${dry ? "would be " : ""}updated, ${withPlace.toLocaleString()} with a place — ${Math.round((Date.now() - started) / 1000)}s`);
  }
  if (page.isDone || !page.continueCursor || pages >= maxPages) break;
  cursor = page.continueCursor;
}

console.log(`\n${dry ? "Dry run: " : ""}${updated.toLocaleString()} of ${seen.toLocaleString()} candidates have a point; ${withPlace.toLocaleString()} now carry a place.`);
process.exit(0);
