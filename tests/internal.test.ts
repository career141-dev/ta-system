/**
 * Every Convex function is internal.
 *
 * A public Convex function can be called by anyone who knows the deployment
 * URL, with no key. The TA functions read candidates' personal data and write
 * any row (ta/commit:apply), and they trust the caller to have checked who is
 * acting — which only holds when the caller is the TA server with the admin
 * key. So a public `query(`, `mutation(` or `action(` in convex/ta fails here.
 *
 * 2 Oct 2026: the same now holds for every module. About 300 of the older
 * functions outside convex/ta were public and checked nobody — one wiped the
 * database, one made every user an admin, others signed links to any CV or
 * messaged candidates. The app calls them with the admin key, which reaches
 * internal functions too, so none needs to be public. httpAction routes are
 * the outside world's way in and check their own signatures (convex/http.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/**
 * Functions deliberately left public, as "path:name". Each needs its own check
 * of who is calling, and a line here saying what it is. Keep it empty.
 */
const ALLOWED_PUBLIC = new Set<string>([]);

const PUBLIC = /export\s+(?:const\s+(\w+)\s*=|(default))\s*(query|mutation|action)\s*\(/g;

const root = join(process.cwd(), "convex");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return f === "_generated" || f === "node_modules" ? [] : walk(p);
    return p.endsWith(".ts") ? [p] : [];
  });

const files = walk(root);
const publics: string[] = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const path = relative(root, file).split("\\").join("/").replace(/\.ts$/, "");
  for (const m of src.matchAll(PUBLIC)) {
    const name = `${path}:${m[1] ?? m[2]}`;
    if (!ALLOWED_PUBLIC.has(name)) publics.push(`${name} (${m[3]})`);
  }
}
ok("no Convex module exports a public query, mutation or action", publics.length === 0, publics.join(", "));
ok("the scan saw the whole backend", files.length > 150, `${files.length} files`);

// The TA functions keep their own, older checks.
const dir = join(root, "ta");
let defined = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(dir, f), "utf8");
  defined += [...src.matchAll(/export const \w+\s*=\s*internal(Query|Mutation|Action)\(/g)].length;
  ok(`${f} does not call TA functions through the public api`, !/\bapi\.ta\./.test(src));
}
ok("the TA functions were found", defined > 50, `${defined} internal functions`);

// The test catches what it is meant to.
const sample = 'export const a = query({});\nexport default mutation({});\nexport const b = internalQuery({});';
const found = [...sample.matchAll(PUBLIC)].map((m) => m[1] ?? m[2]).join(",");
ok("the pattern finds public functions and skips internal ones", found === "a,default", found);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
