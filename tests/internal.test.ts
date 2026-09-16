/**
 * Every function under convex/ta is internal.
 *
 * A public Convex function can be called by anyone who knows the deployment
 * URL, with no key. The TA functions read candidates' personal data and write
 * any row (ta/commit:apply), and they trust the caller to have checked who is
 * acting — which only holds when the caller is the TA server with the admin
 * key. So a public `query(`, `mutation(` or `action(` in convex/ta fails here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const dir = join(process.cwd(), "convex", "ta");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
let defined = 0;
for (const f of files) {
  const src = readFileSync(join(dir, f), "utf8");
  const publics = [...src.matchAll(/export const (\w+)\s*=\s*(query|mutation|action)\(/g)].map((m) => `${m[1]} (${m[2]})`);
  defined += [...src.matchAll(/export const \w+\s*=\s*internal(Query|Mutation|Action)\(/g)].length;
  ok(`${f} has no public functions`, publics.length === 0, publics.join(", "));
  ok(`${f} does not call TA functions through the public api`, !/\bapi\.ta\./.test(src));
}
ok("the TA functions were found", defined > 50, `${defined} internal functions`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
