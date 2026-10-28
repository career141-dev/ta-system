import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import * as tracking from "../convex/ta/tracking";
import { trackingDay } from "../src/lib/taTracking";

// Exercise real Next route and Convex handlers together. Only the session,
// transport and database are replaced; no live services or credentials are used.
type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };
let serial = 0;
const db = {
  get: async (id: string) => structuredClone([...tables.values()].flat().find(r => r._id === id) ?? null),
  insert: async (name: string, row: Row) => { const id = `${name}:${++serial}`; table(name).push({ ...structuredClone(row), _id: id }); return id; },
  patch: async (id: string, row: Row) => Object.assign([...tables.values()].flat().find(r => r._id === id)!, structuredClone(row)),
  query: (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const rows = () => structuredClone(table(name).filter(r => filters.every(f => f(r))));
    const query = { withIndex: (_: string, apply: (q: any) => void) => {
      const q = { eq: (key: string, value: unknown) => { filters.push(r => r[key] === value); return q; } };
      apply(q); return query;
    }, unique: async () => rows()[0] ?? null, collect: async () => rows(), take: async (n: number) => rows().slice(0, n) };
    return query;
  },
};
const users = ["ta", "admin", "ta_lead", "director"].map(role => ({ id: role, email: `${role}@career141.com`, name: role, role, isActive: true }));
for (const u of users) table("users").push({ _id: u.id, email: u.email, fullName: u.name, role: "recruiter", taRole: u.role, isActive: true, isOnboarded: true });
const ctx = { db, auth: { getUserIdentity: async () => null } };
const run = (path: string, args: Row) => {
  const name = path.split(":")[1] as keyof typeof tracking;
  return (tracking[name] as any)._handler(ctx, args);
};
const fixture = { user: users[0] as typeof users[number] | null, users, run };
(globalThis as any).__trackingRoutes = fixture;
const modules: Record<string, string> = {
  "@/data/prime": 'export async function primeStore() {}',
  "@/data/store": 'export const repo = { users: () => globalThis.__trackingRoutes.users };',
  "@/lib/session": 'export async function currentUser() { return globalThis.__trackingRoutes.user; }',
  "@/lib/convexServer": 'export async function convexActorForEmail(email) { const user = globalThis.__trackingRoutes.users.find(u => u.email === email); return user ? { _id: user.id } : null; } export const convexMutation = (path,args) => globalThis.__trackingRoutes.run(path,args); export const convexQuery = convexMutation;',
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier in modules ? { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true } : next(specifier, context);
} });
try {
  const routes = await import("../src/app/api/ta-track/route");
  const uploadRoute = await import("../src/app/api/ta-track/upload/route");
  for (const site of ["https://ta-system.career141.com", "https://aura.career141.com"]) {
    fixture.user = users[0];
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const request = (origin = site, email = users[0].email) => new Request("http://0.0.0.0:3000/api/ta-track", {
      method: "POST", headers: { origin, host: "ta-system.career141.com", "x-forwarded-proto": "https", "content-type": "application/json" }, body: JSON.stringify({ email, tokenHash }),
    });
    assert.equal((await routes.POST(request("https://attacker.example"))).status, 403);
    assert.equal((await routes.POST(request(site, "other@career141.com"))).status, 403);
    assert.equal(table("taTrackingDevices").length, site.includes("aura.") ? 1 : 0, "rejected requests cannot register a browser");
    assert.equal((await routes.POST(request())).status, 200, `registration succeeds through the proxy for ${site}`);
    const now = Date.now();
    const row = { date: trackingDay(now), domain: 'web.whatsapp.com', foregroundMs: 10000, activeMs: 9000, idleMs: 1000, clicks: 4, scrolls: 2, movementSeconds: 3, lastSeen: now };
    const upload = (enabled = true) => uploadRoute.POST(new Request(`${site}/api/ta-track/upload`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ rows: [row], enabled }),
    }));
    assert.equal((await upload()).status, 200);
    assert.equal((await upload()).status, 200, "upload retries succeed");
    const reportRequest = new Request(`${site}/api/ta-track?date=${row.date}&userId=ta`);
    assert.equal((await routes.GET(reportRequest)).status, 403, "TAs cannot read the manager report");
    for (const role of ["admin", "ta_lead"]) {
      fixture.user = users.find(u => u.role === role)!;
      const response = await routes.GET(reportRequest);
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.rows.length, site.includes("aura.") ? 2 : 1);
      assert.ok(report.rows.every((r: Row) => r.clicks === 4 && r.foregroundMs === 10000), "retries do not double counts");
    }
    fixture.user = users.find(u => u.role === "director")!;
    assert.equal((await routes.GET(reportRequest)).status, 403);
    fixture.user = users[0];
    assert.equal((await upload(false)).status, 200, "paused status is uploaded");
    assert.equal((await routes.POST(new Request(`${site}/api/ta-track?action=disconnect`, { method: "POST", headers: { origin: site } }))).status, 200);
    assert.equal((await upload()).status, 401, "disconnected browser cannot upload");
    fixture.user = null;
    assert.equal((await routes.POST(request())).status, 401, "registration requires a signed-in account");
  }
  console.log("Tracking routes: both live aliases behind a proxy, registration, email matching, uploads, reports, permissions, retries, Pause and disconnect passed.");
} finally {
  hooks.deregister();
  delete (globalThis as any).__trackingRoutes;
}
