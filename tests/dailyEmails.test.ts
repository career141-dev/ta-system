import assert from "node:assert/strict";
import * as mail from "../convex/ta/dailyEmails";
import { finalizeDailyEmail } from "../convex/lib/dailyEmail";
import { dailySendProblem, sameCandidateList } from "../src/lib/dailyEmail";
import { workdayDate } from "../src/lib/workday";
import { requiredChecks } from "../convex/lib/workdayChecks";
import { matchReviewReply } from "../src/lib/routing";

// Real internal handlers, synthetic database, no transport or credentials.
type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
let serial = 0;
let now = Date.parse("2026-10-16T05:00:00Z");
const originalNow = Date.now;
Date.now = () => now;
const rows = (table: string) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table)!; };
const put = (table: string, row: Row) => { rows(table).push({ _creationTime: now, ...row }); return row._id; };
const db = {
  get: async (id: string) => structuredClone([...tables.values()].flat().find(r => r._id === id) ?? null),
  insert: async (table: string, value: Row) => put(table, { ...structuredClone(value), _id: `${table}:${++serial}` }),
  patch: async (id: string, value: Row) => { const row = [...tables.values()].flat().find(r => r._id === id); assert.ok(row); Object.assign(row, structuredClone(value)); },
  normalizeId: (_: string, id: string) => id,
  query: (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let desc = false;
    const query = {
      withIndex: (_: string, apply: (q: any) => unknown) => {
        const builder = { eq: (key: string, value: unknown) => { predicates.push(r => r[key] === value); return builder; },
          gte: (key: string, value: number) => { predicates.push(r => r[key] >= value); return builder; } };
        apply(builder); return query;
      },
      filter: (apply: (q: any) => (r: Row) => boolean) => {
        const q = { field: (key: string) => key, eq: (key: string, value: unknown) => (r: Row) => r[key] === value,
          neq: (key: string, value: unknown) => (r: Row) => r[key] !== value,
          gte: (key: string, value: number) => (r: Row) => r[key] >= value,
          and: (...ps: ((r: Row) => boolean)[]) => (r: Row) => ps.every(p => p(r)), or: (...ps: ((r: Row) => boolean)[]) => (r: Row) => ps.some(p => p(r)) };
        predicates.push(apply(q)); return query;
      },
      order: (direction: string) => { desc = direction === "desc"; return query; },
      collect: async () => { const found = rows(table).filter(r => predicates.every(p => p(r))); return structuredClone(desc ? found.toReversed() : found); },
      first: async () => (await query.collect())[0] ?? null,
      take: async (limit: number) => (await query.collect()).slice(0, limit),
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null, runAt: async () => null } } as any;
const run = (name: keyof typeof mail, args: Row) => (mail[name] as any)._handler(ctx, args);
const link = "https://chatgpt.com/share/12345678";
const snapshot = (ids: string[], subject = "MIDDAY 1 - ACME - ENGINEER") => ({ subject, html: "<p>Saved exact content</p>", from: "ta@example.invalid", to: ["director@example.invalid"], cc: [],
  rows: ids.map(applicationId => ({ applicationId, name: applicationId })), attachmentNames: ids.map(id => `${id}.pdf`), effort: {}, introText: "Hello", outroText: "Thanks", researchLink: link,
  extraTo: [], extraCc: [], removed: [] });
const seedUser = (id: string, role = "ta") => put("users", { _id: id, fullName: id, email: `${id}@example.invalid`, role: "recruiter", taRole: role, isActive: true, isOnboarded: true });
seedUser("ta"); seedUser("other"); seedUser("lead", "ta_lead"); seedUser("viewer", "viewer");
put("jobs", { _id: "job", title: "Engineer", taLeadId: "lead", assignedTaIds: ["ta", "other"] });
put("taWorkdays", { _id: "day", userId: "ta", date: workdayDate(now), startedAt: now, jobs: [{ jobId: "job", workType: "100%", addedAt: now, leadId: "lead", modeHistory: [] }] });
put("dailyEmailPolicy", { _id: "policy", key: "midday", requiredFrom: workdayDate(now) });
const candidate = (id: string, owner = "ta") => {
  put("candidates", { _id: `c:${id}`, fullName: id });
  put("applications", { _id: id, candidateId: `c:${id}`, jobId: "job", ownerTaId: owner, currentStage: "second_shortlist", lastStageChangedAt: now, sourceChannel: "Database", setNumber: 1 });
};
const begin = (ids: string[], draftId?: string, extra: Row = {}) => run("begin", { actorId: "ta", jobId: "job", submissionType: draftId ? "midday" : "eod", draftId,
  revision: draftId ? rows("dailyEmails").find(e => e._id === draftId)!.revision : undefined, applicationIds: ids, snapshot: snapshot(ids), confirmed: true, ...extra });

try {
  assert.match(dailySendProblem([], "eod", true)!, /midday/);
  assert.equal(sameCandidateList(["a", "a"], ["a", "b"]), false);
  assert.equal(workdayDate(Date.parse("2026-10-16T18:30:00Z")), "2026-10-17");
  await assert.rejects(() => begin([]), /midday/);
  const first = await run("createDraft", { actorId: "ta", jobId: "job" });
  assert.equal(rows("dailyEmails")[0].number, 1);
  await run("saveDraft", { actorId: "ta", id: first, revision: 0, fields: { subject: "Custom", effort_l: "2", skipAttachments: "yes" } });
  assert.equal(rows("dailyEmails")[0].fields.skipAttachments, "yes");
  await assert.rejects(() => run("saveDraft", { actorId: "ta", id: first, revision: 0, fields: {} }), /another tab/);
  await assert.rejects(() => run("saveDraft", { actorId: "other", id: first, revision: 1, fields: {} }), /your unsent/);
  await assert.rejects(() => run("createDraft", { actorId: "viewer", jobId: "job" }), /cannot access/);
  candidate("a"); candidate("b"); candidate("other-app", "other");
  await assert.rejects(() => begin([], first), /candidate list changed/);
  await assert.rejects(() => begin(["a", "b"], first, { confirmed: false }), /Confirm/);
  await assert.rejects(() => begin(["a", "b"], first, { snapshot: { ...snapshot(["a", "b"]), researchLink: "https://chatgpt.com/c/private" } }), /private/);
  // No JD, profiles or post, and attachments skipped: midday must still succeed with candidates in the table.
  await begin(["a", "b"], first, { snapshot: { ...snapshot(["a", "b"]), attachmentNames: [] } });
  await assert.rejects(() => begin(["a", "b"], first), /still sending/);
  await run("result", { id: first, status: "accepted" });
  await run("result", { id: first, status: "accepted" });
  assert.equal(rows("reviewRounds").length, 1, "Transport acknowledgements are idempotent");
  assert.deepEqual(rows("reviewRounds")[0].applicationIds, ["a", "b"]);
  assert.deepEqual(rows("dailyEmails")[0].snapshot.attachmentNames, [], "Midday sends with empty attachments when skipped");
  assert.equal(rows("dailyEmails")[0].snapshot.html, "<p>Saved exact content</p>");
  let checks = await requiredChecks(ctx, await db.get("day") as any, (await db.get("day"))!.jobs[0]);
  assert.equal(checks.checks.find(c => c.key.startsWith("midday_email:"))?.status, "complete");
  assert.equal(checks.checks.find(c => c.key.startsWith("daily_email:"))?.status, "incomplete", "Midday does not complete EOD");
  const second = await run("createDraft", { actorId: "ta", jobId: "job" });
  assert.equal(rows("dailyEmails").find(e => e._id === second)!.number, 2);
  await assert.rejects(() => begin(["a", "b"], second), /candidate list changed/);
  await begin([], second);
  await run("result", { id: second, status: "failed" });
  await begin([], second);
  await run("result", { id: second, status: "uncertain" });
  await assert.rejects(() => begin([], second), /reconciliation/);
  await assert.rejects(() => run("reconcile", { actorId: "other", id: second, accepted: false, reason: "Verified not sent" }), /TA Lead/);
  await run("reconcile", { actorId: "lead", id: second, accepted: true, reason: "Verified synthetic message reference" });
  assert.equal(rows("reviewRounds").length, 1, "An activity-only email creates no candidate review round");
  candidate("c"); candidate("d"); candidate("e");
  await assert.rejects(() => begin(["c", "d", "e"]), /Today's Checks/);
  // Keep all existing EOD task gates, using their existing exception mechanism.
  checks = await requiredChecks(ctx, await db.get("day") as any, (await db.get("day"))!.jobs[0]);
  for (const check of checks.eodChecks.filter(c => c.exceptionVersion)) put("taWorkdayExceptions", { _id: `exception:${check.key}`, workdayId: "day", jobId: "job", key: check.key,
    version: check.exceptionVersion, action: "submit", at: now, by: "ta", reason: "Synthetic setup exception" });
  const eod = await begin(["c", "d", "e"]);
  await run("result", { id: eod.id, status: "accepted" });
  assert.deepEqual(rows("reviewRounds")[1].applicationIds, ["c", "d", "e"], "EOD includes only the three candidates after midday");
  await assert.rejects(() => begin([]), /already been sent/);
  await assert.rejects(() => run("createDraft", { actorId: "ta", jobId: "job" }), /already been sent/);
  await assert.rejects(() => begin(["c"], undefined, { parentId: eod.id }), /original candidates/);
  const correction = await begin(["c", "d", "e"], undefined, { parentId: eod.id });
  await run("result", { id: correction.id, status: "accepted" });
  assert.equal(rows("reviewRounds").length, 2, "Corrections reuse the original round");
  assert.equal(rows("reviewRounds")[1].revisedAt.length, 1);
  await finalizeDailyEmail(ctx, await db.get(correction.id) as any);
  assert.equal(rows("reviewRounds")[1].revisedAt.length, 1);
  assert.equal(rows("dailyEmails").find(e => e._id === correction.id)!.expiresAt, rows("dailyEmails").find(e => e._id === eod.id)!.expiresAt);
  now += 86400000;
  await assert.rejects(() => run("saveDraft", { actorId: "ta", id: first, revision: 2, fields: {} }), /unsent/);
  assert.equal((await run("list", { actorId: "other", jobId: "job" })).length, 0, "TAs cannot read another sender's copies");
  now += 32 * 86400000;
  assert.equal((await run("list", { actorId: "ta", jobId: "job" }))[0].snapshot, undefined, "Expired content is hidden immediately");
  await assert.rejects(() => begin(["c", "d", "e"], undefined, { parentId: eod.id }), /retained EOD/);
  console.log("Daily email drafts, ordering, ownership, candidates, failures, reconciliation, corrections and retention passed.");
} finally { Date.now = originalNow; }
