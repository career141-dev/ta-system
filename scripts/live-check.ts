/**
 * npm run live:check [-- --pages 40 --size 25 --compare 30]
 *
 * Reads CVs from the current system over the read-only link and prints a
 * report. Stores nothing, writes nothing anywhere, prints no names or CV text.
 * `--pages all` reads every CV (about 26 minutes for 115,000 at 3 requests a second).
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* use the shell's environment */ }

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? fallback : fallback;
};
const { ReadOnlyConvex, liveConvexConfigFromEnv } = await import("@/lib/live/readOnlyConvex");
const { ReadOnlyQdrant, liveQdrantConfigFromEnv } = await import("@/lib/live/readOnlyQdrant");
const { checkLive } = await import("@/lib/live/sync");
const { embedTexts, embedModel, LIVE_DIMS } = await import("@/lib/embed");

const config = liveConvexConfigFromEnv();
if (!config) {
  console.log("Set C141_LIVE_CONVEX_URL and C141_LIVE_CONVEX_ADMIN_KEY (the rotated key) first.");
  process.exit(1);
}
const client = new ReadOnlyConvex(config);
const pagesArg = arg("pages", "40");
const maxPages = pagesArg === "all" ? Number.MAX_SAFE_INTEGER : Number(pagesArg);
const canEmbed = embedModel() === `openai/text-embedding-3-small@${LIVE_DIMS}` || embedModel() === `text-embedding-3-small@${LIVE_DIMS}`;
console.log(`Reading from ${new URL(config.url).host} — query functions only, ${config.rate} requests a second at most.`);

const started = Date.now();
const report = await checkLive(client, {
  pageSize: Number(arg("size", "25")),
  maxPages,
  sameModelSample: canEmbed ? Number(arg("compare", "30")) : 0,
  embed: canEmbed ? async (texts) => { const r = await embedTexts(texts); return r.ok ? r.vectors : null; } : undefined,
});

const q = liveQdrantConfigFromEnv();
let qdrant: unknown = "not configured";
if (q) {
  try {
    const client = new ReadOnlyQdrant(q);
    const info = await client.info();
    qdrant = { points: info.points_count ?? null, width: info.config?.params?.vectors?.size ?? null, distance: info.config?.params?.vectors?.distance ?? null };
  } catch (e) {
    qdrant = `could not read: ${(e as Error).message}`;
  }
}

const out = { at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), report, qdrant };
fs.mkdirSync(".data", { recursive: true });
const file = path.join(".data", `live-check-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));

const r = report;
const pct = (n: number) => (r.resumesRead ? `${Math.round((n / r.resumesRead) * 100)}%` : "—");
console.log(`\nRead ${r.resumesRead.toLocaleString()} CVs with vectors in ${out.seconds}s (${r.requests} requests)${r.complete ? " — all of them" : " — a sample; --pages all for every CV"}.`);
console.log(`CV text: ${r.text.inDatabase} in the database (${pct(r.text.inDatabase)}), ${r.text.onlyInR2} only in R2, ${r.text.none} with none.`);
console.log(`Vector widths: ${Object.entries(r.vectorWidths).map(([w, n]) => `${w} → ${n}`).join(", ")}`);
console.log(`CVs sharing an identical vector: ${r.cvsInIdenticalGroups} (${pct(r.cvsInIdenticalGroups)}); largest groups ${r.identicalVectorGroups.map((g) => g.size).join(", ") || "none"}`);
console.log(r.placeholder.checked ? `Empty-CV placeholder vector: ${r.placeholder.matches} (${pct(r.placeholder.matches)})${r.sameModel.checked && r.sameModel.agree === 0 ? " — not reliable: it assumes text-embedding-3-small" : ""}` : "Placeholder check skipped (no embedding key here).");
console.log(r.sameModel.checked ? `Same model as text-embedding-3-small: ${r.sameModel.agree} of ${r.sameModel.checked} agree; ${r.sameModel.disagree} look like another model (lowest similarity ${r.sameModel.lowest?.toFixed(3)})` : "Model check skipped.");
if (r.sameModel.checked && r.sameModel.agree === 0) console.log("  → The stored vectors are from a different model. Search sentences can't be compared with them; live:sync embeds CVs here instead.");
console.log(`Candidate records sampled: ${r.sampleCandidates.read}; with title ${r.sampleCandidates.withTitle}, skills ${r.sampleCandidates.withSkills}, job history ${r.sampleCandidates.withHistory}.`);
console.log(`Qdrant: ${JSON.stringify(qdrant)}`);
console.log(`\nSaved to ${file} (counts only — no names, no CV text).`);
