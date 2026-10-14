import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { HOLIDAYS } from "../src/lib/calendar";
import { BACKGROUND_ALERT_ROLLOUT, backgroundDeadline, directorNeedsShortlist, inactivityStart } from "../src/lib/backgroundAlerts";
import * as background from "../convex/ta/backgroundAlerts";
import * as migration from "../convex/migrations/backgroundTaAlerts";
import * as notifications from "../convex/ta/notifications";
import * as workdays from "../convex/ta/workdays";
import * as tablesApi from "../convex/ta/tables";
import { completionBlockers, emailBlockers } from "../src/lib/workday";

type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
const rows = (table: string) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table)!; };
let seq = 0;
const monday = Date.parse("2026-10-12T17:00:00+05:30");
let clock = monday;
const realNow = Date.now;
Date.now = () => clock;
const put = (table: string, row: Row): Row => {
  const stored = { _id: `${table}:${++seq}`, _creationTime: clock, ...row };
  rows(table).push(stored); return stored;
};
const pending: { name: string; args: Row }[] = [];
const db = {
  get: async (id: string) => structuredClone([...tables.values()].flat().find(r => r._id === id) ?? null),
  normalizeId: (table: string, id: string) => rows(table).some(r => r._id === id) ? id : null,
  insert: async (table: string, row: Row) => put(table, row)._id,
  patch: async (id: string, patch: Row) => Object.assign([...tables.values()].flat().find(r => r._id === id)!, patch),
  query: (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let reverse = false;
    const query = {
      withIndex: (_name: string, cb: (q: any) => unknown) => {
        const builder = {
          eq: (key: string, value: any) => { predicates.push(r => r[key] === value); return builder; },
          gte: (key: string, value: any) => { predicates.push(r => r[key] >= value); return builder; },
          lte: (key: string, value: any) => { predicates.push(r => r[key] === undefined || r[key] <= value); return builder; },
        };
        cb(builder); return query;
      },
      filter: (cb: (q: any) => (r: Row) => boolean) => {
        const builder = {
          field: (field: string) => ({ field }),
          eq: (left: { field: string }, right: any) => (r: Row) => r[left.field] === right,
          and: (...parts: ((r: Row) => boolean)[]) => (r: Row) => parts.every(p => p(r)),
          or: (...parts: ((r: Row) => boolean)[]) => (r: Row) => parts.some(p => p(r)),
        };
        predicates.push(cb(builder)); return query;
      },
      order: (dir: string) => { reverse = dir === "desc"; return query; },
      collect: async () => {
        const found = rows(table).filter(r => predicates.every(p => p(r))).sort((a, b) => a._creationTime - b._creationTime);
        return structuredClone(reverse ? found.toReversed() : found);
      },
      first: async () => (await query.collect())[0] ?? null,
      take: async (n: number) => (await query.collect()).slice(0, n),
      paginate: async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
        // Cursor follows a stable insertion position even when resolution removes rows.
        const found = await query.collect();
        const ordered = rows(table).map(r => r._id);
        const start = cursor ? ordered.indexOf(cursor) + 1 : 0;
        const remaining = found.filter(r => ordered.indexOf(r._id) >= start);
        const page = remaining.slice(0, numItems);
        return { page, isDone: remaining.length <= numItems, continueCursor: page.at(-1)?._id ?? cursor };
      },
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: {
  runAfter: async (_delay: number, ref: any, args: Row) => { pending.push({ name: getFunctionName(ref), args }); },
} } as any;
const run = (name: keyof typeof background, args: Row = {}) => (background[name] as any)._handler(ctx, args);
const drain = async () => {
  let calls = 0;
  while (pending.length) {
    assert.ok(++calls < 1000, "continuations must terminate");
    const next = pending.shift()!;
    await run(next.name.split(":")[1] as keyof typeof background, next.args);
  }
};
const ta = put("users", { _id: "ta", fullName: "TA", role: "recruiter", taRole: "ta", isActive: true, isOnboarded: true, email: "ta@example.invalid" });
put("users", { _id: "support", fullName: "Support", role: "recruiter", taRole: "ta_support", isActive: true });
put("users", { _id: "lead", fullName: "Lead Name", role: "senior_ta", taRole: "ta_lead", isActive: true });
put("users", { _id: "outsider", fullName: "Other", role: "recruiter", taRole: "ta", isActive: true });
const job = put("jobs", { _id: "job", title: "Engineer", status: "active", taLeadId: "lead", assignedTaIds: ["ta", "support"] });
const seat = put("jobAssignments", { jobId: "job", userId: "ta", assignedAt: new Date(monday).toISOString(), isActive: true, assignmentRole: "primary_recruiter" });
const supportSeat = put("jobAssignments", { jobId: "job", userId: "support", assignedAt: new Date(monday).toISOString(), isActive: true, assignmentRole: "supporting_recruiter" });
const init = (dryRun: boolean) => (migration.initialize as any)._handler(ctx, { dryRun });
const bell = (userId = "ta") => (notifications.listForUser as any)._handler(ctx, { userId });
const round = (patch: Row = {}) => put("reviewRounds", { openingId: "job", kind: "director", dispatch: "sent", sentBy: "ta", sentAt: monday,
  applicationIds: ["app"], decisions: [], status: "awaiting", ...patch });
const hour = 3_600_000;

try {
  assert.equal(inactivityStart(100, 200, 300), 300);
  assert.equal(backgroundDeadline(monday), monday + 24 * hour);
  const friday = Date.parse("2026-10-16T17:00:00+05:30");
  assert.equal(backgroundDeadline(friday), Date.parse("2026-10-19T17:00:00+05:30"));
  HOLIDAYS.push("2026-10-19");
  assert.equal(backgroundDeadline(friday), Date.parse("2026-10-20T17:00:00+05:30"));
  HOLIDAYS.pop();
  const midnight = Date.parse("2026-10-19T00:00:00+05:30");
  assert.equal(backgroundDeadline(midnight), midnight + 24 * hour);
  const sent = { kind: "director", dispatch: "sent", sentAt: monday, applicationIds: ["app"], decisions: [] };
  assert.equal(directorNeedsShortlist(sent, monday, monday + 24 * hour - 1), false);
  assert.equal(directorNeedsShortlist(sent, monday, monday + 24 * hour), true);
  assert.equal(directorNeedsShortlist({ ...sent, applicationIds: ["app", "app2"], decisions: [{ applicationId: "app2", outcome: "shortlisted" }] }, monday, clock + 24 * hour), false);
  assert.equal((await init(true)).initialized, false);
  assert.equal(rows("taSettings").length, 0);
  await run("sweep"); assert.equal(pending.length, 0);
  await init(false);
  clock += hour;
  assert.equal((await init(false)).startedAt, monday, "reruns never restart rollout");
  assert.equal(rows("taSettings")[0].key, BACKGROUND_ALERT_ROLLOUT);
  clock = monday + 24 * hour - 1;
  await run("checkJob", { jobId: "job" }); assert.equal(rows("taAlerts").length, 0);
  clock++;
  // No UI/session activity is needed to run the scheduler.
  await run("sweep"); await drain();
  assert.equal(rows("taAlerts").length, 2);
  assert.equal(rows("notifications").length, 2);
  assert.equal(rows("taAlerts")[0].dueAt, clock);
  await Promise.all([run("checkJob", { jobId: "job" }), run("checkJob", { jobId: "job" })]);
  assert.equal(rows("notifications").length, 2);
  assert.equal((await bell("lead")).unreadCount, 0, "no automatic lead escalation");
  const alert = rows("taAlerts").find(a => a.assignedTo === "ta")!;
  await (notifications.markRead as any)._handler(ctx, { userId: "ta", notificationId: rows("notifications")[0]._id });
  assert.equal((await bell()).unreadCount, 0);
  assert.equal((await background.outstandingFor(ctx, "ta" as any)).length, 1, "reading does not resolve");
  assert.equal((await background.outstandingFor(ctx, "outsider" as any)).length, 0);
  const loaded = await (tablesApi.page as any)._handler(ctx, { table: "alerts" });
  assert.equal(loaded.rows.length, 2);
  assert.equal(loaded.rows[0].openingId, "job");
  assert.equal(loaded.rows[0].kind, "job_no_new_candidates");
  const payload = await (workdays.dashboard as any)._handler(ctx, { actorId: ta._id });
  assert.equal(payload.backgroundAlerts.length, 1);
  assert.equal(payload.active, null, "alerts are available before starting work");
  assert.equal(completionBlockers([]).length, 0);
  assert.equal(emailBlockers([]).length, 0);
  // A CV received through any source resets the clock. Its old createdAt text does not matter.
  const app = put("applications", { _id: "app", jobId: "job", sourceChannel: "email", createdAt: "2020-01-01", currentStage: "new_cvs", lastStageChangedAt: clock });
  assert.equal((await bell()).notifications.length, 0, "stale reminders disappear before cron resolution");
  assert.equal((await (tablesApi.page as any)._handler(ctx, { table: "alerts" })).rows.length, 0);
  await run("resolvePage"); await drain(); assert.ok(alert.resolvedAt);
  clock += 23 * hour;
  app.currentStage = "second_shortlist"; app.lastStageChangedAt = clock;
  await run("checkJob", { jobId: "job" }); assert.equal(rows("notifications").length, 2);
  clock += hour;
  await run("checkJob", { jobId: "job" }); assert.equal(rows("notifications").length, 4, "stage edits did not reset arrival");
  seat.isActive = false;
  assert.equal((await background.outstandingFor(ctx, "ta" as any)).length, 0, "revoked seat cannot use stale assignedTaIds");
  const reassign = put("jobAssignments", { ...seat, _id: "reassigned", assignedAt: new Date(clock).toISOString(), isActive: true });
  await run("resolvePage"); await drain();
  await run("checkJob", { jobId: "job" }); assert.equal((await background.outstandingFor(ctx, "ta" as any)).length, 0);
  clock += 24 * hour;
  await run("checkJob", { jobId: "job" }); assert.equal((await background.outstandingFor(ctx, "ta" as any)).length, 1);

  const before = rows("notifications").length;
  const awaiting = round();
  await run("checkRound", { roundId: awaiting._id });
  assert.equal(rows("notifications").length, before + 1);
  const notice = (await bell()).notifications.find((n: Row) => n.type === "director_no_shortlist");
  assert.match(notice.body, /No director reply/);
  assert.match(notice.body, /Contact your TA Lead outside the system/);
  assert.match(notice.body, /Lead Name/);
  assert.equal(notice.href, "/openings/job/eod?kind=director");
  awaiting.revisedAt = [clock];
  await run("checkRound", { roundId: awaiting._id }); assert.equal(rows("notifications").length, before + 1);
  awaiting.decisions = [{ applicationId: "app", outcome: "rejected" }]; awaiting.status = "returned"; awaiting.returnedAt = clock;
  await run("checkRound", { roundId: awaiting._id });
  assert.match((await bell()).notifications.find((n: Row) => n.type === "director_no_shortlist").body, /Director shortlisted no candidates/);
  for (const patch of [{ dispatch: "held" }, { kind: "client" }, { applicationIds: [] }, { sentAt: monday - 1 }, { sentAt: clock },
    { decisions: [{ applicationId: "app", outcome: "shortlisted" }] }]) {
    const r = round(patch); await run("checkRound", { roundId: r._id });
    assert.equal(rows("notifications").length, before + 1);
  }
  const partial = round({ status: "partial", decisions: [{ applicationId: "app", outcome: "hold" }] });
  await run("checkRound", { roundId: partial._id }); assert.equal(rows("notifications").length, before + 2);
  const outsiderDecision = round({ decisions: [{ applicationId: "not-in-email", outcome: "shortlisted" }] });
  assert.equal(directorNeedsShortlist(outsiderDecision as any, monday, clock), true);
  awaiting.decisions = [{ applicationId: "app", outcome: "shortlisted" }];
  await run("resolvePage"); await drain();
  assert.ok(rows("taAlerts").find(a => a.subjectId === awaiting._id)!.resolvedAt);
  app.currentStage = "director_shortlist"; app.lastStageChangedAt = clock;
  assert.equal((await background.outstandingFor(ctx, "ta" as any)).filter(a => a.kind === "director_no_shortlist").length, 0);
  app.currentStage = "interview"; app.stageHistory = [{ stage: "director_shortlist", enteredAt: new Date(clock).toISOString() }];
  const manualRound = round(); await run("checkRound", { roundId: manualRound._id });
  assert.equal(rows("notifications").length, before + 2, "recorded manual shortlist counts after moving onward");
  job.status = "filled";
  assert.equal((await background.outstandingFor(ctx, "ta" as any)).length, 0);
  job.status = "active"; job.binnedAt = clock;
  assert.equal((await background.outstandingFor(ctx, "support" as any)).length, 0);
  delete job.binnedAt;
  reassign.isActive = false; supportSeat.isActive = false;
  await run("sweep"); await drain();

  // More than one page: nothing beyond the first thirty is dropped.
  for (let i = 0; i < 65; i++) put("jobs", { _id: `paged-${i}`, title: `Job ${i}`, status: "active", assignedTaIds: ["ta"], assignedAt: monday });
  await run("sweep"); await drain();
  assert.equal(rows("taAlerts").filter(a => a.openingId?.startsWith("paged-")).length, 65);
  for (const j of rows("jobs").filter(j => j._id.startsWith("paged-"))) j.status = "cancelled";
  await run("resolvePage"); await drain();
  assert.equal(rows("taAlerts").filter(a => a.openingId?.startsWith("paged-") && !a.resolvedAt).length, 0);
  // Multiple round pages, separate submissions, rejected and unanswered all qualify.
  app.currentStage = "new_cvs"; app.stageHistory = [];
  reassign.isActive = true;
  const count = rows("notifications").length;
  for (let i = 0; i < 65; i++) round({ status: i % 2 ? "returned" : "awaiting", decisions: i % 2 ? [{ applicationId: "app", outcome: "rejected" }] : [] });
  await run("roundsPage"); await drain();
  assert.ok(rows("notifications").length >= count + 65);
  assert.equal((await bell("lead")).notifications.length, 0);
  for (const channel of ["linkedin", "headhunting", "manual"]) {
    clock = backgroundDeadline(clock);
    put("applications", { jobId: "job", sourceChannel: channel, createdAt: clock });
    assert.equal((await background.outstandingFor(ctx, "ta" as any)).filter(a => a.kind === "job_no_new_candidates").length, 0);
    clock += 1;
    await run("checkJob", { jobId: "job" });
    assert.equal((await background.outstandingFor(ctx, "ta" as any)).filter(a => a.kind === "job_no_new_candidates").length, 0);
  }
  console.log("Background alert deadlines, rollout, scheduler pagination, deduplication, recipients, workday payload, bell and resolution passed.");
} finally {
  Date.now = realNow;
  HOLIDAYS.length = 0;
}
