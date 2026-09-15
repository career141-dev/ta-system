/**
 * Row counts for every table in convex/schema.ts, against the local backend.
 *
 * Run before a test phase and after it: the difference should be exactly the
 * test records the phase created, and nothing after cleanup.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/db-baseline.ts [out.json]
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

const schema = fs.readFileSync("convex/schema.ts", "utf8");
const tables = [...schema.matchAll(/^ {2}(\w+): defineTable\(/gm)].map((m) => m[1]);

const counts: Record<string, number> = {};
for (const table of tables) {
  let cursor: string | null = null;
  let n = 0;
  for (;;) {
    const page: { count: number; isDone: boolean; continueCursor: string | null } =
      await convexQuery("ta/storage:countPage", { table, cursor });
    n += page.count;
    if (page.isDone || !page.continueCursor) break;
    cursor = page.continueCursor;
  }
  counts[table] = n;
}

const out = process.argv[2];
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), counts }, null, 2));
const width = Math.max(...tables.map((t) => t.length));
for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  if (n > 0) console.log(`  ${t.padEnd(width)} ${n.toLocaleString().padStart(9)}`);
}
console.log(`\n${tables.length} tables, ${Object.values(counts).filter((n) => n === 0).length} empty.`);
process.exit(0);
