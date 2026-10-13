import assert from "node:assert/strict";
import {
  applyCarryForwards,
  completionBlockers,
  extraPositionNeedsApproval,
  validateCarry,
  workdayDate,
  type WorkdayCheck,
} from "../src/lib/workday";
import * as workdays from "../convex/ta/workdays";
import { assertWorkdayScope } from "../convex/lib/workdayScope";

// Exercise real mutation handlers with synthetic rows, without a backend or messages.
type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
let seq = 0;
const now = Date.parse("2026-10-13T04:00:00Z");
const realNow = Date.now;
let clock = now;
Date.now = () => clock;
const rows = (table: string) => {
  if (!tables.has(table)) tables.set(table, []);
  return tables.get(table)!;
};
const put = (table: string, row: Row) => {
  rows(table).push({ _creationTime: clock, ...row });
  return row._id;
};
const db = {
  get: async (id: string) =>
    structuredClone(
      [...tables.values()].flat().find((r) => r._id === id) ?? null,
    ),
  insert: async (table: string, row: Row) => {
    const id = `${table}:${++seq}`;
    put(table, { ...row, _id: id });
    return id;
  },
  patch: async (id: string, patch: Row) => {
    const row = [...tables.values()].flat().find((r) => r._id === id);
    assert.ok(row);
    Object.assign(row, structuredClone(patch));
  },
  normalizeId: (_table: string, id: string) => id,
  query: (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let reverse = false;
    const query = {
      withIndex: (_name: string, callback: (builder: any) => unknown) => {
        const builder = {
          eq: (field: string, value: unknown) => {
            predicates.push((row) => row[field] === value);
            return builder;
          },
          gte: (field: string, value: number) => {
            predicates.push((row) => row[field] >= value);
            return builder;
          },
        };
        callback(builder);
        return query;
      },
      filter: (callback: (builder: any) => (row: Row) => boolean) => {
        const builder = {
          field: (field: string) => ({ field }),
          eq: (left: { field: string }, right: unknown) => (row: Row) =>
            row[left.field] === right,
          neq: (left: { field: string }, right: unknown) => (row: Row) =>
            row[left.field] !== right,
          gte: (left: { field: string }, right: number) => (row: Row) =>
            row[left.field] >= right,
          and:
            (...parts: ((row: Row) => boolean)[]) =>
            (row: Row) =>
              parts.every((part) => part(row)),
          or:
            (...parts: ((row: Row) => boolean)[]) =>
            (row: Row) =>
              parts.some((part) => part(row)),
        };
        predicates.push(callback(builder));
        return query;
      },
      order: (direction: string) => {
        reverse = direction === "desc";
        return query;
      },
      collect: async () => {
        const found = rows(table).filter((row) =>
          predicates.every((p) => p(row)),
        );
        return structuredClone(reverse ? found.toReversed() : found);
      },
      first: async () => (await query.collect())[0] ?? null,
      take: async (limit: number) => (await query.collect()).slice(0, limit),
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null } } as any;
const run = (name: keyof typeof workdays, args: Row) =>
  (workdays[name] as any)._handler(ctx, args);
const user = (id: string, taRole: string) =>
  put("users", {
    _id: id,
    fullName: id,
    email: `${id}@example.invalid`,
    role: taRole === "ta_lead" ? "senior_ta" : "recruiter",
    taRole,
    isActive: true,
    isOnboarded: true,
  });
user("ta", "ta");
user("support", "ta_support");
user("lead", "ta_lead");
user("otherLead", "ta_lead");
for (const id of ["job1", "job2", "job3"])
  put("jobs", {
    _id: id,
    title: id,
    taLeadId: id === "job3" ? "otherLead" : "lead",
    assignedTaIds: ["ta", "support"],
  });
put("jobPosts", {
  _id: "post",
  openingId: "job1",
  assignedTaId: "ta",
  channel: "linkedin",
  externalUrl: "https://example.invalid/job",
});

try {
  assert.equal((await run("dashboard", { actorId: "ta" })).active, null);
  assert.equal(rows("taWorkdays").length, 0);
  assert.equal(workdayDate(Date.parse("2026-10-12T20:00:00Z")), "2026-10-13");
  assert.equal(extraPositionNeedsApproval("ta", 1), true);
  assert.equal(extraPositionNeedsApproval("ta_support", 1), false);
  const check: WorkdayCheck = {
    key: "details:a",
    jobId: "job1",
    kind: "details",
    href: "/",
    label: "Missing CV",
    canCarry: true,
    evidenceAt: 10,
  };
  const carry = {
    key: check.key,
    reason: "CV requested",
    nextAction: "Call tomorrow",
    dueAt: clock + 1000,
    recordedAt: clock,
    evidenceAt: 10,
  };
  assert.ok(applyCarryForwards([check], [carry], clock)[0].waiting);
  assert.equal(
    applyCarryForwards([{ ...check, evidenceAt: 11 }], [carry], clock)[0]
      .waiting,
    undefined,
  );
  assert.equal(
    applyCarryForwards([check], [carry], clock + 1000)[0].waiting,
    undefined,
  );
  assert.throws(() =>
    validateCarry(
      { ...check, canCarry: false },
      "waiting",
      "call",
      clock + 1,
      clock,
    ),
  );
  assert.throws(() => validateCarry(check, "", "call", clock + 1, clock));
  assert.throws(() => validateCarry(check, "waiting", "call", clock, clock));

  const day = await run("start", {
    actorId: "ta",
    jobId: "job1",
    workType: "100%",
  });
  assert.deepEqual(
    await run("start", { actorId: "ta", jobId: "job1", workType: "100%" }),
    day,
  );
  assert.equal(rows("taWorkdays").length, 1);
  assert.equal(rows("notifications").length, 1);
  assert.equal(rows("taWorkdays")[0].startedAt, clock);
  await assert.rejects(
    () => assertWorkdayScope(ctx, rows("users")[0] as any, "job2" as any),
    /approval/,
  );
  assert.equal(
    (
      await run("addPosition", {
        actorId: "ta",
        workdayId: day.id,
        jobId: "job2",
        workType: "Add-on",
      })
    ).pending,
    true,
  );
  assert.equal(rows("taWorkdays")[0].jobs.length, 1);
  const request = rows("taWorkdayRequests")[0];
  await assert.rejects(
    () =>
      run("decide", {
        actorId: "otherLead",
        requestId: request._id,
        approve: true,
        reason: "Support needed",
      }),
    /TA Lead/,
  );
  await run("decide", {
    actorId: "lead",
    requestId: request._id,
    approve: true,
    reason: "Support needed",
  });
  assert.equal(rows("taWorkdays")[0].jobs.length, 2);
  await assertWorkdayScope(ctx, rows("users")[0] as any, "job2" as any);

  const support = await run("start", {
    actorId: "support",
    jobId: "job1",
    workType: "Follow-up",
  });
  assert.equal(
    (
      await run("addPosition", {
        actorId: "support",
        workdayId: support.id,
        jobId: "job3",
        workType: "100%",
      })
    ).pending,
    false,
  );
  // A lead sees only their jobs, even when support works across two teams.
  const leaderView = await run("dashboard", { actorId: "lead", detail: true });
  const supportView = leaderView.team.find((d: Row) => d.userId === "support");
  assert.deepEqual(
    supportView.jobs.map((j: Row) => j.jobId),
    ["job1"],
  );
  await workdays.recordActiveMode(
    ctx,
    "support" as any,
    "job3" as any,
    "Add-on",
  );
  await workdays.recordActiveMode(
    ctx,
    "support" as any,
    "job3" as any,
    "Add-on",
  );
  assert.equal(rows("taWorkdays")[1].jobs[1].modeHistory.length, 2);

  put("candidates", {
    _id: "huntedCandidate",
    fullName: "Synthetic headhunt",
    cvUploadId: "cv",
    expectedSalary: 0,
    noticePeriodDays: 0,
  });
  put("applications", {
    _id: "huntedApp",
    candidateId: "huntedCandidate",
    jobId: "job3",
    ownerTaId: "support",
    shortlistedAt: clock,
    sourceChannel: "headhunting",
    currentStage: "follow_up",
    createdAt: clock,
    lastStageChangedAt: clock,
    followUpExpectedSalary: false,
    isActive: true,
  });
  let hunted = (
    await run("dashboard", { actorId: "support" })
  ).active.jobs.find((j: Row) => j.jobId === "job3");
  let details = hunted.checks.find((c: Row) => c.kind === "details");
  assert.ok(
    details.label.includes("expected salary"),
    "Explicit per-application false overrides a candidate's salary",
  );
  assert.equal(
    details.canCarry,
    false,
    "No request recorded means actionable missing work",
  );
  await db.patch("huntedApp", { followUpLastManualSendAt: clock });
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  details = hunted.checks.find((c: Row) => c.kind === "details");
  await run("carry", {
    actorId: "support",
    workdayId: support.id,
    jobId: "job3",
    key: details.key,
    reason: "Asked candidate for salary",
    nextAction: "Follow up tomorrow",
    dueAt: clock + 86400000,
  });
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  assert.ok(hunted.checks.find((c: Row) => c.kind === "details").waiting);
  clock++;
  await db.patch("huntedApp", { lastCandidateReplyAt: clock });
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  assert.equal(
    hunted.checks.find((c: Row) => c.kind === "details").waiting,
    undefined,
  );
  await db.patch("huntedApp", { followUpExpectedSalary: true });
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  assert.ok(hunted.checks.some((c: Row) => c.kind === "handoff"));
  await assert.rejects(
    () =>
      run("carry", {
        actorId: "support",
        workdayId: support.id,
        jobId: "job3",
        key: "handoff:huntedApp",
        reason: "Later",
        nextAction: "Move tomorrow",
        dueAt: clock + 86400000,
      }),
    /must be completed/,
  );
  await db.patch("huntedApp", { currentStage: "second_shortlist" });
  const uncertain = await run("beginMail", {
    actorId: "support",
    jobId: "job3",
    applicationIds: ["huntedApp"],
    subject: "Synthetic shortlist",
    sentTo: "director@example.invalid",
  });
  await run("mailResult", { id: uncertain.id, status: "uncertain" });
  await assert.rejects(
    () =>
      run("beginMail", {
        actorId: "support",
        jobId: "job3",
        applicationIds: ["huntedApp"],
        subject: "Synthetic shortlist",
        sentTo: "director@example.invalid",
      }),
    /uncertain/,
  );
  await assert.rejects(
    () =>
      run("reconcileMail", {
        actorId: "lead",
        id: uncertain.id,
        accepted: true,
        reason: "Verified mailbox",
      }),
    /TA Lead/,
  );
  await run("reconcileMail", {
    actorId: "otherLead",
    id: uncertain.id,
    accepted: true,
    reason: "Verified synthetic mailbox message reference",
  });
  assert.equal(rows("reviewRounds")[0].applicationIds[0], "huntedApp");
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  assert.equal(hunted.checks.length, 0);

  put("applications", {
    _id: "app",
    candidateId: "candidate",
    jobId: "job1",
    jobPostId: "post",
    candidateName: "Synthetic CV",
    sourceChannel: "linkedin",
    currentStage: "new_cvs",
    createdAt: clock,
    lastStageChangedAt: clock,
    isActive: true,
  });
  let finish = await run("finish", { actorId: "ta", workdayId: day.id });
  assert.equal(finish.ok, false);
  assert.equal(rows("taWorkdays")[0].finishedAt, undefined);
  await assert.rejects(
    () =>
      run("carry", {
        actorId: "ta",
        workdayId: day.id,
        jobId: "job1",
        key: "review:app",
        reason: "Waiting",
        nextAction: "Tomorrow",
        dueAt: clock + 1000,
      }),
    /must be completed/,
  );
  await assert.rejects(
    () =>
      run("markReviewed", {
        actorId: "support",
        workdayId: support.id,
        applicationId: "app",
      }),
    /assigned TA/,
  );
  await run("markReviewed", {
    actorId: "ta",
    workdayId: day.id,
    applicationId: "app",
  });
  assert.equal((await db.get("app"))?.workdayReviewedAt, clock);

  for (const jobId of ["job1", "job2"]) {
    const receipt = await run("beginMail", {
      actorId: "ta",
      jobId,
      applicationIds: [],
      subject: "Synthetic activity",
      sentTo: "director@example.invalid",
    });
    await assert.rejects(
      () =>
        run("beginMail", {
          actorId: "ta",
          jobId,
          applicationIds: [],
          subject: "Synthetic activity",
          sentTo: "director@example.invalid",
        }),
      /send in progress/,
    );
    await run("mailResult", { id: receipt.id, status: "accepted" });
    assert.equal(
      (await run("finish", { actorId: "ta", workdayId: day.id })).ok,
      false,
    );
    await run("finalizeMail", { actorId: "ta", id: receipt.id });
  }
  // A CV arriving after email acceptance still blocks the final transaction.
  clock += 100;
  put("applications", {
    _id: "late",
    candidateId: "lateCandidate",
    jobId: "job1",
    jobPostId: "post",
    sourceChannel: "email",
    currentStage: "new_cvs",
    createdAt: clock,
    lastStageChangedAt: clock,
    isActive: true,
  });
  assert.equal(
    (await run("finish", { actorId: "ta", workdayId: day.id })).ok,
    false,
  );
  await run("markReviewed", {
    actorId: "ta",
    workdayId: day.id,
    applicationId: "late",
  });
  finish = await run("finish", { actorId: "ta", workdayId: day.id });
  assert.equal(finish.ok, true);
  assert.equal(rows("taWorkdays")[0].finishedAt, clock);
  assert.deepEqual(
    await run("finish", { actorId: "ta", workdayId: day.id }),
    finish,
  );
  await assert.rejects(
    () => run("start", { actorId: "ta", jobId: "job1", workType: "100%" }),
    /already finished/,
  );
  await assert.rejects(
    () => run("finish", { actorId: "support", workdayId: day.id }),
    /not yours/,
  );
  await assert.rejects(
    () => assertWorkdayScope(ctx, rows("users")[0] as any, "job1" as any),
    /Start your workday/,
  );
  const frozen = (await run("dashboard", { actorId: "ta", detail: true }))
    .history[0];
  const finishedStatus = await run("dashboard", { actorId: "ta" });
  assert.equal(finishedStatus.lastFinishedAt, clock);
  assert.equal(finishedStatus.lastFinishedDate, workdayDate(clock));
  assert.equal(completionBlockers(frozen.jobs).length, 0);
  console.log(
    "  ok  workday times, approval boundaries, shared CV review, late arrivals, carry-forward expiry, email receipts, scoped lead history and idempotent completion",
  );
} finally {
  Date.now = realNow;
}
