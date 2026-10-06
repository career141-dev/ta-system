/**
 * The column-aware PDF text reader must finish on any PDF (6 Oct): items at
 * absurd or infinite positions froze the backend's action runner.
 */
import { extractPageTextWithLayout } from "../convex/lib/pdfLayout";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const item = (str: string, x: number, y: number, width = 60) => ({ str, width, height: 10, transform: [10, 0, 0, 10, x, y] });
const timed = (f: () => string) => { const t = Date.now(); const r = f(); return { r, ms: Date.now() - t }; };

// A normal two-column CV page.
const left = Array.from({ length: 20 }, (_, i) => item(`Left line ${i}`, 40, 700 - i * 14, 120));
const right = Array.from({ length: 20 }, (_, i) => item(`Right line ${i}`, 330, 700 - i * 14, 200));
const two = extractPageTextWithLayout([...left, ...right], 612, 792);
eq("two columns read left then right", two.indexOf("Left line 19") < two.indexOf("Right line 0"), true);

console.log("\nbroken PDFs finish quickly");
for (const [label, bad] of [
  ["infinite x", item("ghost", Infinity, 400)],
  ["huge x", item("ghost", 1e18, 400)],
  ["huge width", { ...item("ghost", 50, 400), width: 1e18 }],
  ["NaN y", item("ghost", 50, NaN)],
] as const) {
  const { r, ms } = timed(() => extractPageTextWithLayout([...left, ...right, bad], 612, 792));
  eq(`${label}: under 200 ms`, ms < 200, true);
  eq(`${label}: real text kept`, r.includes("Left line 0") && r.includes("Right line 19"), true);
}

const many = Array.from({ length: 60000 }, (_, i) => item(`w${i}`, (i * 7) % 560, 780 - ((i * 3) % 760), 8));
const big = timed(() => extractPageTextWithLayout(many, 612, 792));
// The point is that it finishes (the old code never did); CI machines are slow, so the bound is generous.
eq("60,000 items: no stack overflow, finishes within 30 s", big.ms < 30000 && big.r.length > 0, true);

eq("no page size given still works", extractPageTextWithLayout([item("Hello", 40, 700)], NaN, 0), "Hello");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
