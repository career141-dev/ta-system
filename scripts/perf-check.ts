/**
 * What a page costs before it renders anything of its own.
 *
 * Times the data loading each screen does, against the real backend, with
 * every Convex call logged (path, milliseconds, kilobytes). Run it before and
 * after a performance change; the totals are the comparison.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/perf-check.ts
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
process.env.C141_STORE = "convex";
process.env.C141_TIMING = "1";

const { primeStore, resetStore } = await import("@/data/prime");
const { repo } = await import("@/data/store");
const { alertsFor } = await import("@/lib/sla");

const time = async (label: string, fn: () => unknown) => {
  const t = performance.now();
  await fn();
  console.log(`== ${label}: ${Math.round(performance.now() - t)}ms\n`);
};

const openingId = process.argv[2];

await time("cold: layout (every page)", async () => {
  await primeStore({ allApplications: true, followUps: true });
  const azma = repo.users().find((u) => u.name === "Azma");
  if (azma) alertsFor(azma.id);
});

await time("warm: layout again (next click)", async () => {
  await primeStore({ allApplications: true, followUps: true });
});

await time("alerts computed x2 (layout + dashboard)", async () => {
  const azma = repo.users().find((u) => u.name === "Azma");
  if (azma) { alertsFor(azma.id); alertsFor(azma.id); }
});

const first = repo.openings()[0];
await time(`opening page (${openingId ?? first?.title})`, async () => {
  await primeStore({ openingId: openingId ?? first?.id });
});

resetStore();
await time("cold: sign-in page (no user)", async () => {
  await primeStore({ allApplications: true, followUps: true });
});

process.exit(0);
