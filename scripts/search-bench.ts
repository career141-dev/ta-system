/**
 * npm run bench:search [-- --runs 3]
 *
 * Times the Database results page's search pipeline, step by step, against the
 * LOCAL Convex backend and Qdrant (C141_STORE=convex in .env.local). Mirrors
 * src/app/database/results/page.tsx in order: prime, retrieve, filter, and the
 * widen/blocker counts. Reads only — nothing is written.
 *
 * --old runs the pre-optimisation page logic, for comparison.
 *
 * Each query runs cold (fresh working set, as after any save) and then warm.
 */
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 2;

const { repo } = await import("@/data/store");
const { primeStore, resetStore } = await import("@/data/prime");
const { keywordRetrieve } = await import("@/lib/retrieve");
const { parseQuery, describe, withoutChip, criteriaFromParams } = await import("@/lib/query");
const { BELOW_BAR, RELEVANT_SIMILARITY, embedQuery, isMeaningBased, nearestCandidates } = await import("@/lib/embed");
const { refreshCandidateVectors } = await import("@/lib/dbMatch");
const { isConvex } = await import("@/data/mode");
const OLD = process.argv.includes("--old");

type Mode = "natural" | "boolean" | "meaning";
const QUERIES: { q: string; mode: Mode }[] = [
  { q: "brand manager in Colombo with 5 years", mode: "natural" },
  { q: "software engineer java", mode: "natural" },
  { q: '"Accountant" AND Excel', mode: "boolean" },
  { q: "someone who has run trade marketing for a consumer goods company", mode: "meaning" },
];

async function once(q: string, mode: Mode) {
  const steps: [string, number][] = [];
  const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
    const s = performance.now();
    const r = await fn();
    steps.push([label, performance.now() - s]);
    return r;
  };
  const start = performance.now();

  await time("prime (tables + all applications)", () => primeStore({ allApplications: true }));
  const vocab = await time("vocabulary", () => repo.vocabulary());
  const parsed = mode !== "boolean" ? parseQuery(q, vocab) : null;
  const criteria = parsed?.criteria ?? criteriaFromParams({});

  let similarity: Map<string, number> | undefined;
  if (mode !== "meaning") {
    const terms = [q, ...criteria.titles, ...criteria.skills.slice(0, 3), ...criteria.employers.slice(0, 2), ...criteria.qualifications.slice(0, 2)];
    const hits = await time(`keyword retrieve (${new Set(terms.map((t) => t.trim()).filter((t) => t.length > 2)).size} terms)`, () => keywordRetrieve(terms, 150));
    await time(`prime ${hits.length} hits`, () => primeStore({ candidateIds: hits }));
  } else {
    const vectors = isConvex() && !OLD ? { ok: true as const } : await time("refreshCandidateVectors", () => refreshCandidateVectors());
    const query = vectors.ok ? await time("embed query", () => embedQuery(q)) : vectors;
    if (query.ok) {
      const hits = await time("qdrant nearest", () => nearestCandidates(query.vectors[0], 1000));
      similarity = new Map(hits.map((n) => [n.id, n.similarity]));
      await time(`prime ${hits.length} hits`, () => primeStore({ candidateIds: hits.map((h) => h.id) }));
    } else {
      console.log(`   meaning unavailable: ${query.reason}`);
    }
  }

  const best = similarity ? Math.max(0, ...similarity.values()) : 0;
  const bar = isMeaningBased() ? RELEVANT_SIMILARITY : Math.max(0.08, best * 0.6);
  const floor = bar;
  const { total } = await time("searchDatabase", () =>
    repo.searchDatabase(criteria, { boolean: mode === "boolean" ? q : null, limit: Number.MAX_SAFE_INTEGER, similarity, floor, belowFloor: bar - BELOW_BAR }),
  );

  const widened = await time(`widen suggestions (${criteria.locations.length ? vocab.cities.length : 0} cities)`, () => {
    if (!criteria.locations.length) return [];
    const cities = vocab.cities.filter((c) => !criteria.locations.includes(c));
    if (OLD) {
      return cities.map((city) => [city, repo.searchDatabase({ ...criteria, locations: [...criteria.locations, city] }, { boolean: mode === "boolean" ? q : null, limit: 1, similarity, floor }).total - total] as const).filter(([, n]) => n > 0);
    }
    const anywhere = repo.searchDatabase({ ...criteria, locations: [] }, { boolean: mode === "boolean" ? q : null, limit: Number.MAX_SAFE_INTEGER, similarity, floor });
    const byPlace = new Map<string, number>();
    for (const r of anywhere.results) { const k = (r.candidate.location ?? "").toLowerCase(); byPlace.set(k, (byPlace.get(k) ?? 0) + 1); }
    const chosen = new Set(criteria.locations.map((l) => l.toLowerCase()));
    return cities.map((city) => [city, chosen.has(city.toLowerCase()) ? 0 : (byPlace.get(city.toLowerCase()) ?? 0)] as const).filter(([, n]) => n > 0);
  });
  await time("blockers", () => {
    if (total !== 0 || mode === "boolean") return;
    for (const chip of describe(criteria)) {
      const relaxed = criteriaFromParams(Object.fromEntries(new URLSearchParams(withoutChip(criteria, chip).slice(1))));
      repo.searchDatabase(relaxed, { limit: 1, similarity, floor });
    }
  });

  return { total, widened: JSON.stringify(widened), ms: performance.now() - start, steps, primed: repo.candidates().length };
}

const fmt = (n: number) => `${Math.round(n)}`.padStart(6) + " ms";
for (const { q, mode } of QUERIES) {
  console.log(`\n■ [${mode}] ${q}`);
  for (let r = 0; r < runs; r++) {
    if (r === 0) resetStore();
    const res = await once(q, mode);
    console.log(`  ${r === 0 ? "cold" : "warm"}: ${fmt(res.ms)}  → ${res.total} results (working set ${res.primed}) widen=${res.widened}`);
    for (const [label, ms] of res.steps) if (ms >= 5) console.log(`      ${label.padEnd(44)} ${fmt(ms)}`);
  }
}
