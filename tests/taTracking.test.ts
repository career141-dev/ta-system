import assert from "node:assert/strict";
import * as tracking from "../convex/ta/tracking";
import { canViewTaTracking, validateTrackingRows, trackingDay } from "../src/lib/taTracking";
import { trackingLoginRequest } from "../src/lib/taTrackingLogin";
import { trackingErrorMessage } from "../src/lib/taTrackingError";

assert.match(trackingErrorMessage(new Error("Could not find function ta/tracking:pair")), /not been installed/);
assert.match(trackingErrorMessage(new Error("Disconnect an existing browser before pairing another.")), /browser limit/);
assert.match(trackingErrorMessage(new Error("fetch failed")), /not responding/);
assert.doesNotMatch(trackingErrorMessage(new Error("private backend detail")), /private backend detail|Disconnect/);

const login = { email: "TA@career141.com", tokenHash: "a".repeat(64) };
assert.equal(trackingLoginRequest(login).email, "ta@career141.com");
for (const override of [{ email: "fake@example.com" }, { tokenHash: "bad" }, { email: '' }, { tokenHash: '' }]) assert.throws(() => trackingLoginRequest({ ...login, ...override }));

// Exercise actual internal handlers with synthetic accounts and snapshots.
type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };
let sequence = 0;
const db = {
  get: async (id: string) => structuredClone([...tables.values()].flat().find(r => r._id === id) ?? null),
  insert: async (name: string, data: Row) => { const id = `${name}:${++sequence}`; table(name).push({ ...structuredClone(data), _id: id }); return id; },
  patch: async (id: string, data: Row) => Object.assign([...tables.values()].flat().find(r => r._id === id)!, structuredClone(data)),
  delete: async (id: string) => { for (const rows of tables.values()) { const i = rows.findIndex(r => r._id === id); if (i >= 0) rows.splice(i, 1); } },
  query: (name: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    const result = () => structuredClone(table(name).filter(r => predicates.every(p => p(r))));
    const query = {
      withIndex: (_: string, apply: (q: any) => unknown) => {
        const q = { eq: (key: string, value: unknown) => { predicates.push(r => r[key] === value); return q; }, lt: (key: string, value: number) => { predicates.push(r => r[key] < value); return q; } };
        apply(q); return query;
      }, collect: async () => result(), unique: async () => result()[0] ?? null, take: async (count: number) => result().slice(0, count),
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null } };
const run = (name: keyof typeof tracking, args: Row) => (tracking[name] as any)._handler(ctx, args);
for (const role of ["admin", "ta_lead", "director", "ta", "ta_support", "viewer", "client"]) table("users").push({ _id: role, fullName: role, email: `${role}@example.invalid`, role: "recruiter", taRole: role, isActive: true, isOnboarded: true });
const now = Date.now();
const row = { date: trackingDay(now), domain: "web.whatsapp.com", foregroundMs: 10000, activeMs: 8000, idleMs: 2000, clicks: 3, scrolls: 2, movementSeconds: 4, lastSeen: now };
for (const role of ["ta", "ta_support", "viewer", "director", "client"]) {
  assert.equal(canViewTaTracking(role), false);
  await assert.rejects(() => run("report", { actorId: role, date: row.date }), /Only admins/);
}
assert.throws(() => validateTrackingRows([{ ...row, domain: "web.whatsapp.com/private?message=secret" }]), /domains only/);
assert.throws(() => validateTrackingRows([{ ...row, clicks: -1 }]), /Invalid activity/);
assert.throws(() => validateTrackingRows([{ ...row, activeMs: 9999 }]), /daily totals/);
assert.throws(() => validateTrackingRows([{ ...row, date: "2020-01-01" }]), /30 days/);
const stripped = validateTrackingRows([{ ...row, userId: "admin", name: "Forged", fullUrl: "secret" }])[0];
assert.equal("userId" in stripped, false);
assert.equal("fullUrl" in stripped, false);
assert.equal((await run("upload", { tokenHash: "unknown", rows: [row], enabled: true })).ok, false);
await run("pair", { actorId: "ta", tokenHash: "synthetic-token" });
await run("pair", { actorId: "ta", tokenHash: "synthetic-token" });
assert.equal(table("taTrackingDevices").length, 1, "repeating sign-in confirmation is idempotent");
await assert.rejects(() => run("pair", { actorId: "ta_support", tokenHash: "synthetic-token" }), /new browser sign-in/);
const upload = (rows: Row[]) => run("upload", { tokenHash: "synthetic-token", rows, enabled: true });
await upload([row]); await upload([row]);
assert.equal(table("taTrackingRows").length, 1);
assert.equal(table("taTrackingRows")[0].clicks, 3, "retries do not double count");
assert.equal(table("taTrackingRows")[0].userId, "ta", "identity comes from pairing");
await upload([{ ...row, foregroundMs: 11000, activeMs: 9000, clicks: 5, lastSeen: now + 1000 }]);
await upload([row]);
assert.equal(table("taTrackingRows")[0].clicks, 5, "stale uploads cannot roll totals back");
for (const role of ["admin", "ta_lead"]) {
  const report = await run("report", { actorId: role, date: row.date, userId: "ta" });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].name, "ta");
  assert.equal("tokenHash" in report.devices[0], false);
}
assert.equal((await run("report", { actorId: "admin", date: row.date, userId: "ta_support" })).rows.length, 0);
const ta = table("users").find(u => u._id === "ta")!;
ta.isActive = false;
assert.equal((await upload([row])).ok, false, "deactivated accounts cannot upload");
ta.isActive = true; ta.isOnboarded = false;
assert.equal((await upload([row])).ok, false, "accounts awaiting role approval cannot upload");
ta.isOnboarded = true;
await run("disconnect", { actorId: "ta" });
assert.equal((await upload([row])).ok, false, "revoked pairing cannot upload");
table("taTrackingRows").push({ ...row, _id: "expired", lastSeen: now - 31 * 86400000 });
await run("purgeExpired", {});
assert.equal(table("taTrackingRows").some(r => r._id === "expired"), false);
console.log("TA Track: role gates, verified identity, validation, retry deduplication, stale uploads, filtering, revocation and retention passed.");
