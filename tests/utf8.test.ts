/**
 * Every source file is valid UTF-8.
 *
 * A Windows "…" and "’" (bytes 0x85, 0x92) saved into CandidateRow.tsx and
 * actions.ts stopped the production build: "stream did not contain valid
 * UTF-8" (29 Oct, PR #321). Type checks and tests did not notice.
 */
import fs from "node:fs";
import path from "node:path";

const roots = ["src", "convex", "tests", ".claude/skills", "docs"];
const bad: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "_generated") walk(p);
    } else if (/\.(tsx?|m?js|css|json|md)$/.test(e.name)) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
      } catch {
        bad.push(p);
      }
    }
  }
};
roots.forEach(walk);
console.log(bad.length ? `  FAIL not UTF-8: ${bad.join(", ")}` : "  ok   every source file is UTF-8");
console.log(`${bad.length ? 0 : 1} passed, ${bad.length ? 1 : 0} failed`);
if (bad.length) process.exit(1);
