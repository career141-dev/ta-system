import assert from "node:assert/strict";
import { eod } from "../convex/ta/supportViews";

type Row = Record<string, any>;
const now = Date.now();
const records: Record<string, Row[]> = {
  users: [{ _id: "support", fullName: "Support", role: "recruiter", taRole: "ta_support", isActive: true },
    { _id: "ta", fullName: "TA", role: "recruiter", taRole: "ta", isActive: true },
    { _id: "disabled", role: "recruiter", taRole: "ta_support", isActive: false }],
  jobs: [{ _id: "job", assignedTaIds: ["ta"] }, { _id: "binned", binnedAt: now }],
  dailyEmails: Array.from({ length: 10 }, (_, i) => ({ _id: `email${i}`, jobId: "job", userId: i % 2 ? "ta" : "other-ta", date: "2026-10-23",
    submissionType: "eod", status: "accepted", revision: 1, expiresAt: now + 100000,
    fields: { PRIVATE_DRAFT: "not returned" }, snapshot: { subject: "Saved EOD", html: "<p>Exact saved preview</p>", effort: { lEffort: i, l: 2 }, attachments: [{ id: "secret" }] } })),
};
records.dailyEmails.push({ ...records.dailyEmails[0], _id: "midday", submissionType: "midday" },
  { ...records.dailyEmails[0], _id: "other-date", date: "2026-10-22" },
  { ...records.dailyEmails[0], _id: "other-job", jobId: "elsewhere" });
for (const actor of records.users) actor.isOnboarded = true;
let indexUsed = "";
const db = {
  normalizeId: (_table: string, id: string) => id,
  get: async (id: string) => Object.values(records).flat().find(r => r._id === id) ?? null,
  query: (table: string) => {
    const predicates: ((r: Row) => boolean)[] = [];
    let desc = false;
    const query = {
      withIndex: (index: string, apply: (q: any) => unknown) => {
        indexUsed = index;
        const q = { eq: (key: string, value: unknown) => { predicates.push(r => r[key] === value); return q; } };
        apply(q); return query;
      },
      filter: (apply: (q: any) => (r: Row) => boolean) => {
        predicates.push(apply({ field: (key: string) => key, eq: (key: string, value: unknown) => (r: Row) => r[key] === value,
          and: (...ps: ((r: Row) => boolean)[]) => (r: Row) => ps.every(p => p(r)) })); return query;
      },
      order: (direction: string) => { desc = direction === "desc"; return query; },
      paginate: async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
        const all = records[table].filter(r => predicates.every(p => p(r)));
        if (desc) all.reverse();
        const offset = Number(cursor) || 0;
        return { page: all.slice(offset, offset + numItems), isDone: offset + numItems >= all.length, continueCursor: String(offset + numItems) };
      },
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null } } as any;
const run = (over: Row = {}) => (eod as any)._handler(ctx, { actorId: "support", jobId: "job", date: "2026-10-23", ...over });
const before = JSON.stringify(records);
const first = await run();
assert.equal(first.emails.length, 8);
assert.equal(indexUsed, "by_job_date", "History reads only the selected position/date range");
assert.equal(first.nextCursor, "8");
assert.equal((await run({ cursor: first.nextCursor })).emails.length, 2);
assert.equal((await run({ taId: "ta" })).emails.length, 5);
assert.ok(first.emails.some((e: Row) => e.userId === "other-ta"), "Support reads another TA without a work assignment");
assert.equal(first.emails[0].effort.l, 2);
assert.ok(!JSON.stringify(first).includes("PRIVATE_DRAFT"));
assert.ok(!JSON.stringify(first).includes("secret"), "Attachment identifiers are not exposed");
assert.equal(JSON.stringify(records), before, "Opening the view does not write or send anything");
records.dailyEmails[9].expiresAt = now - 1;
const expired = (await run()).emails.find((e: Row) => e.id === "email9");
assert.equal(expired.html, undefined);
assert.equal(expired.effort, undefined);
await assert.rejects(() => run({ actorId: "ta" }), /Only TA Support/);
await assert.rejects(() => run({ actorId: "disabled" }));
await assert.rejects(() => run({ jobId: "binned" }), /unavailable/);
await assert.rejects(() => run({ date: "invalid" }), /valid date/);
assert.equal((await run({ taId: "nonexistent" })).emails.length, 0);
console.log("Support EOD reads are scoped, paginated, read-only, retention-aware and unavailable to ordinary TAs.");
