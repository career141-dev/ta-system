import assert from "node:assert/strict";
import * as access from "../convex/ta/openingAccess";

type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
let sequence = 0;
let clock = Date.parse("2026-10-20T08:00:00Z");
const realNow = Date.now;
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
  get: async (id: string) => structuredClone([...tables.values()].flat().find((row) => row._id === id) ?? null),
  insert: async (table: string, row: Row) => {
    const id = `${table}:${++sequence}`;
    put(table, { ...structuredClone(row), _id: id });
    return id;
  },
  patch: async (id: string, patch: Row) => {
    const row = [...tables.values()].flat().find((item) => item._id === id);
    assert.ok(row, `missing row ${id}`);
    Object.assign(row, structuredClone(patch));
  },
  normalizeId: (_table: string, id: string) =>
    [...tables.values()].flat().some((row) => row._id === id) ? id : null,
  query: (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    const query = {
      withIndex: (_name: string, callback: (builder: any) => unknown) => {
        const builder = {
          eq: (field: string, value: unknown) => {
            predicates.push((row) => row[field] === value);
            return builder;
          },
        };
        callback(builder);
        return query;
      },
      filter: (callback: (builder: any) => (row: Row) => boolean) => {
        const builder = {
          field: (field: string) => ({ field }),
          eq: (left: { field: string }, right: unknown) => (row: Row) => row[left.field] === right,
        };
        predicates.push(callback(builder));
        return query;
      },
      collect: async () => structuredClone(rows(table).filter((row) => predicates.every((test) => test(row)))),
      first: async () => (await query.collect())[0] ?? null,
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null } } as any;
const run = (name: keyof typeof access, args: Row) => (access[name] as any)._handler(ctx, args);

function user(id: string, taRole: string, active = true) {
  put("users", {
    _id: id,
    fullName: id,
    email: `${id}@example.invalid`,
    role: taRole === "ta_lead" ? "senior_ta" : taRole === "admin" ? "admin" : "recruiter",
    taRole,
    isActive: active,
    isOnboarded: true,
  });
}
function job(id: string, patch: Row = {}) {
  put("jobs", {
    _id: id,
    title: id,
    clientName: "Client",
    status: "active",
    positionStatus: "active",
    isConfidential: false,
    taLeadId: "lead",
    assignedTaIds: [],
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
    ...patch,
  });
}

user("ta", "ta");
user("support", "ta_support");
user("lead", "ta_lead");
user("otherLead", "ta_lead");
user("admin", "admin");
user("inactiveLead", "ta_lead", false);
job("available");
job("assigned", { assignedTaIds: ["ta"] });
job("confidential", { isConfidential: true });
job("closed", { status: "filled", positionStatus: "filled" });
job("noLead", { taLeadId: "inactiveLead" });

try {
  const available = await run("listAvailable", { actorId: "ta" });
  assert.deepEqual(available.map((opening: Row) => opening.id), ["available"]);
  await assert.rejects(
    run("request", { actorId: "lead", openingId: "available" }),
    /Only a TA can request/,
  );

  const requested = await run("request", {
    actorId: "ta",
    openingId: "available",
    reason: "I am supporting this search",
  });
  assert.equal(requested.ok, true);
  assert.deepEqual(rows("jobs").find((row) => row._id === "available")!.assignedTaIds, [], "requesting alone grants no access");
  assert.equal(rows("jobAssignments").length, 0, "requesting alone creates no assignment");
  assert.equal(rows("openingAccessRequests").length, 1);
  assert.equal(rows("notifications")[0].userId, "lead");
  assert.equal(rows("notifications")[0].type, "opening_access_requested");
  assert.equal(rows("activityLog")[0].action, "opening_access_requested");

  const duplicate = await run("request", { actorId: "ta", openingId: "available" });
  assert.equal(duplicate.alreadyPending, true);
  assert.equal(rows("openingAccessRequests").length, 1, "duplicate pending requests are not inserted");
  assert.equal(rows("notifications").length, 1, "duplicate requests do not notify twice");

  const waiting = await run("listAvailable", { actorId: "ta" });
  assert.equal(waiting.find((opening: Row) => opening.id === "available").requestStatus, "pending");
  const leadQueue = await run("listPendingForApprover", { actorId: "lead" });
  assert.deepEqual(leadQueue.map((request: Row) => request.id), [requested.id]);
  assert.deepEqual(await run("listPendingForApprover", { actorId: "otherLead" }), []);

  await assert.rejects(
    run("decide", { actorId: "ta", requestId: requested.id, approve: true }),
    /Only this opening's TA Lead/,
  );
  await assert.rejects(
    run("decide", { actorId: "otherLead", requestId: requested.id, approve: true }),
    /Only this opening's TA Lead/,
  );
  await assert.rejects(
    run("decide", { actorId: "lead", requestId: requested.id, approve: false }),
    /reason for rejecting/,
  );

  await run("decide", {
    actorId: "lead",
    requestId: requested.id,
    approve: false,
    reason: "The team is full",
  });
  assert.equal(rows("openingAccessRequests")[0].status, "rejected");
  assert.equal(rows("notifications").at(-1)!.type, "opening_access_rejected");
  assert.equal(rows("jobAssignments").length, 0);

  clock += 1000;
  const retried = await run("request", { actorId: "ta", openingId: "available" });
  assert.notEqual(retried.id, requested.id, "a rejected request may be submitted again");
  assert.equal(rows("openingAccessRequests").length, 2);

  await run("decide", {
    actorId: "admin",
    requestId: retried.id,
    approve: true,
    reason: "Approved as cover",
  });
  const assignment = rows("jobAssignments")[0];
  assert.equal(assignment.userId, "ta");
  assert.equal(assignment.assignmentRole, "supporting_recruiter");
  assert.equal(assignment.workingStage, "100%");
  assert.equal(assignment.isActive, true);
  assert.deepEqual(rows("jobs").find((row) => row._id === "available")!.assignedTaIds, ["ta"]);
  assert.equal(rows("notifications").at(-1)!.type, "opening_access_approved");
  assert.equal(rows("activityLog").at(-1)!.action, "opening_access_approved");
  assert.ok(!(await run("listAvailable", { actorId: "ta" })).some((opening: Row) => opening.id === "available"));

  await run("decide", { actorId: "admin", requestId: retried.id, approve: true });
  assert.equal(rows("jobAssignments").length, 1, "retrying an approval does not duplicate the assignment");

  await assert.rejects(
    run("request", { actorId: "support", openingId: "noLead" }),
    /does not have an active TA Lead/,
  );

  console.log("opening access request workflow passed");
} finally {
  Date.now = realNow;
}
