/**
 * Page speed, measured the way a browser experiences it — against a running
 * production server (`next build && next start -p 3177`).
 *
 * For each page: server response time (first load, then a repeat, which is what
 * the next click costs), HTML size, and the JavaScript the browser has to
 * download and run for it. Signs in as a real desk user with a proper session
 * cookie, so the numbers include everything a signed-in page does.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/perf-pages.ts [base]
 */
import fs from "node:fs";
import { createHmac } from "node:crypto";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}
process.env.C141_STORE = "convex";

const { convexQuery } = await import("@/lib/convexServer");
const { secret } = await import("@/lib/sign");

const base = (process.argv[2] || "http://127.0.0.1:3177").replace(/\/+$/, "");
type U = { _id: string; fullName?: string; name?: string; email: string };
const users = await convexQuery<U[]>("ta/users:listTaUsers", {});
const azma = users.find((u) => /azma/i.test(u.fullName ?? u.name ?? u.email));
if (!azma) throw new Error("No desk user named Azma to sign in as.");
// The app's user ids are the backend's, mapped in data/convex/map.ts.
const cookie = `c141_user=${azma._id}.${createHmac("sha256", secret()).update(azma._id).digest("base64url")}`;

const openings = await convexQuery<{ id: string; status: string; totalApplications: number }[]>("ta/openings:list", { limit: 500 });
const busy = openings.filter((o) => o.status === "open").sort((a, b) => b.totalApplications - a.totalApplications)[0];

const pages = [
  "/signin",
  "/",
  "/openings",
  busy ? `/openings/${busy.id}` : null,
  "/database",
  "/database/results?q=" + encodeURIComponent("Brand Manager in Colombo with Campaign Management and Brand Strategy"),
  "/database/results?page=2&q=" + encodeURIComponent("Brand Manager in Colombo with Campaign Management and Brand Strategy"),
  "/candidates/j977xsnw4g0pdtnmyy31sydx1s8dnc2d",
  "/alerts",
  "/intake",
  "/reports",
].filter(Boolean) as string[];

const scriptSizes = new Map<string, number>();
async function jsFor(html: string): Promise<number> {
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))];
  let total = 0;
  for (const src of srcs) {
    if (!scriptSizes.has(src)) {
      const r = await fetch(new URL(src, base));
      scriptSizes.set(src, (await r.arrayBuffer()).byteLength);
    }
    total += scriptSizes.get(src)!;
  }
  return total;
}

async function hit(path: string) {
  const t = performance.now();
  const res = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t), html };
}

const kb = (n: number) => `${Math.round(n / 1024)}KB`.padStart(7);
console.log(`${"page".padEnd(52)} status   first  repeat    html      js`);
for (const p of pages) {
  const a = await hit(p);
  const b = await hit(p);
  const js = a.status === 200 ? await jsFor(a.html) : 0;
  console.log(
    `${p.slice(0, 52).padEnd(52)} ${String(a.status).padStart(6)} ${String(a.ms).padStart(6)}ms ${String(b.ms).padStart(6)}ms ${kb(a.html.length)} ${kb(js)}`,
  );
}
process.exit(0);
