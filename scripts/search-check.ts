/**
 * Run a real search the way the Database screen runs it.
 *
 * Same path, same order, same functions: prime, read the sentence, ask the
 * matching engine, then let the desk's own criteria narrow what it sent back.
 * If this returns real people in a sensible order, the screen will too — and
 * where it does not, this says which step lost them rather than leaving a blank
 * page to interpret.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/search-check.ts "Brand Manager in Colombo with Campaign Management"
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
process.env.C141_STORE = "convex";

import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { parseQuery } from "@/lib/query";
import { deskCriteria, engineSearch, scoreFromEngine, hitsAndMisses } from "@/lib/engineSearch";

const q = process.argv.slice(2).join(" ") ||
  "Brand Manager in Colombo with Campaign Management and Brand Strategy";

console.log(`query: ${q}\n`);

await primeStore({ allApplications: true });

// 1 ─ the sentence, read against the database's own vocabulary
const vocab = repo.vocabulary();
const parsed = parseQuery(q, vocab);
const c = parsed.criteria;
console.log(`vocabulary   ${vocab.titles.length} titles · ${vocab.skills.length} skills · ${vocab.cities.length} cities`);
console.log("understood");
console.log(`  titles      ${c.titles.join(", ") || "—"}`);
console.log(`  skills      ${c.skills.join(", ") || "—"}`);
console.log(`  locations   ${c.locations.join(", ") || "—"}`);
console.log(`  industries  ${c.industries.join(", ") || "—"}`);
console.log(`  ignored     ${parsed.ignored.slice(0, 8).join(", ") || "—"}`);

// 2 ─ the engine: it finds and it ranks
const engine = await engineSearch(q, c, 100);
console.log(`\nengine`);
console.log(`  read as     ${engine.interpretation?.interpretation ?? "—"}`);
console.log(`  keywords    ${(engine.interpretation?.keywords ?? []).slice(0, 10).join(", ") || "—"}`);
console.log(`  returned    ${engine.hits.length} candidates  (top score ${engine.hits[0]?.score ?? "—"})`);

const hits = new Map(engine.hits.map((h) => [h.candidateId, h]));
await primeStore({ candidateIds: engine.hits.map((h) => h.candidateId) });
const similarity = new Map(engine.hits.map((h) => [h.candidateId, h.score / 100]));

// 3 ─ the desk's own criteria, applied over the engine's order
const { results, total } = repo.searchDatabase(deskCriteria(c), { limit: 10, similarity, floor: 0 });
console.log(`\n${total} survive the desk's criteria. Top ${Math.min(10, results.length)}:\n`);

for (const [i, r] of results.slice(0, 10).entries()) {
  const p = r.candidate;
  const hit = hits.get(p.id);
  const score = hit ? scoreFromEngine(hit) : null;
  console.log(`${String(i + 1).padStart(2)}. ${p.fullName}${score ? `  —  ${score.overall} (${score.band})` : ""}`);
  console.log(`    ${[p.currentTitle, p.currentEmployer].filter(Boolean).join(" at ") || "no current role on file"}`);
  console.log(
    `    ${[
      p.location ?? "location unknown",
      p.totalExperienceYears != null ? `${p.totalExperienceYears}y` : "experience unknown",
      p.noticePeriodDays != null ? `${p.noticePeriodDays}d notice` : "notice unknown",
    ].join(" · ")}`,
  );
  if (score?.reasons.length) console.log(`    why: ${score.reasons[0]}`);
  const chips = hit ? hitsAndMisses(hit, p, c, false) : { hits: r.hits, misses: r.misses };
  if (chips.hits.length) console.log(`    matched: ${chips.hits.slice(0, 6).join(", ")}`);
  if (chips.misses.length) console.log(`    missing: ${chips.misses.slice(0, 4).join(", ")}`);
  console.log();
}

const real = results.filter((r) => !(r.candidate.email ?? "").includes("example.invalid")).length;
console.log(
  real === results.length && results.length > 0
    ? `All ${results.length} are real database records.\n`
    : `${results.length - real} of ${results.length} are seed records — the store is not on Convex.\n`,
);
