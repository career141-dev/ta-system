/**
 * npm run live:sync [-- --pages 40 --size 25]
 *
 * Copies CVs from the current system into THIS build's local data, reading
 * over the read-only link, and embeds each CV here with this platform's model
 * (about $0.00002 a CV — the live vectors are from an unidentified model; see
 * lib/live/sync). Nothing is written to the current system. `--pages all` for
 * every CV. Run it on the test server, not a laptop: this is real CV data.
 */
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* use the shell's environment */ }

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? fallback : fallback;
};
const { ReadOnlyConvex, liveConvexConfigFromEnv } = await import("@/lib/live/readOnlyConvex");
const { syncLive } = await import("@/lib/live/sync");
const { repo } = await import("@/data/store");

const config = liveConvexConfigFromEnv();
if (!config) {
  console.log("Set C141_LIVE_CONVEX_URL and C141_LIVE_CONVEX_ADMIN_KEY (the rotated key) first.");
  process.exit(1);
}
const pagesArg = arg("pages", "40");
const started = Date.now();
console.log(`Copying from ${new URL(config.url).host} — query functions only, ${config.rate} requests a second at most.`);
const skipVectors = process.argv.includes("--skip-vectors");
const useLiveVectors = process.argv.includes("--use-live-vectors");
const result = await syncLive(new ReadOnlyConvex(config), {
  pageSize: Number(arg("size", "25")),
  maxPages: pagesArg === "all" ? Number.MAX_SAFE_INTEGER : Number(pagesArg),
  skipVectors,
  useLiveVectors,
  onPage: (n) => { if (n % 500 === 0) console.log(`  ${n.toLocaleString()} read…`); },
});
console.log(`\nRead ${result.read.toLocaleString()} CVs in ${Math.round((Date.now() - started) / 1000)}s (${result.requests} requests).`);
console.log(`Added ${result.added}, refreshed ${result.updated}; ${result.vectors} CVs embedded here (${result.embedTokens.toLocaleString()} tokens ≈ $${((result.embedTokens / 1e6) * 0.02).toFixed(4)}).`);
console.log(`This build now holds ${repo.liveMirrorCount().toLocaleString()} CVs from the current system.`);
