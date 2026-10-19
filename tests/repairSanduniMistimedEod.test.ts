import assert from "node:assert/strict";
import { run } from "../convex/admin/repairSanduniMistimedEod";

type Row = Record<string, any>;
const tables = new Map<string, Row[]>();
const rows = (table: string) => {
  if (!tables.has(table)) tables.set(table, []);
  return tables.get(table)!;
};
const put = (table: string, row: Row) => rows(table).push(structuredClone(row));
const find = (id: string) => [...tables.values()].flat().find((row) => row._id === id);

const db = {
  get: async (id: string) => structuredClone(find(id) ?? null),
  insert: async (table: string, row: Row) => {
    const id = table === "taWorkdays" ? "friday" : `${table}-${rows(table).length + 1}`;
    put(table, { _id: id, ...row });
    return id;
  },
  patch: async (id: string, patch: Row) => {
    const row = find(id);
    assert.ok(row, `Missing row ${id}`);
    Object.assign(row, structuredClone(patch));
  },
  query: (table: string) => {
    const predicates: Array<(row: Row) => boolean> = [];
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
      collect: async () => structuredClone(rows(table).filter((row) => predicates.every((predicate) => predicate(row)))),
    };
    return query;
  },
};
const ctx = { db } as any;
const execute = (dryRun: boolean) => (run as any)._handler(ctx, { dryRun });

put("users", { _id: "sanduni", email: "sanduni@career141.com", fullName: "Sanduni", isActive: true });
// The repair must follow the immutable receipt link even if the opening was
// renamed or binned after the EOD was accepted.
put("jobs", { _id: "job", title: "Head of Manufacturing Excellence", binnedAt: 50 });
put("taWorkdays", {
  _id: "monday",
  userId: "sanduni",
  date: "2026-10-19",
  startedAt: 30,
  finishedAt: 40,
  closureReason: "eod",
  jobs: [{ jobId: "job", workType: "100%", addedAt: 30, leadId: "lead", modeHistory: [] }],
  completion: { id: "monday", finishedAt: 40, closureReason: "eod", jobs: [] },
});
put("dailyEmails", {
  _id: "email",
  userId: "sanduni",
  jobId: "job",
  date: "2026-10-19",
  submissionType: "eod",
  status: "accepted",
  acceptedAt: 40,
  finalizedAt: 40,
  applicationIds: ["application"],
  roundId: "round",
});
put("reviewRounds", {
  _id: "round",
  openingId: "job",
  kind: "director",
  sentBy: "sanduni",
  sentAt: 40,
  applicationIds: ["application"],
});
put("taWorkdayMail", {
  _id: "receipt",
  dailyEmailId: "email",
  workdayId: "monday",
  userId: "sanduni",
  jobId: "job",
  submissionType: "eod",
  status: "accepted",
  acceptedAt: 40,
  finalizedAt: 40,
  startedAt: 39,
  applicationIds: ["application"],
});
put("taWorkdayLeads", { _id: "mondayLead", workdayId: "monday", leadId: "lead", finishedAt: 40 });
put("taWorkdayRequests", {
  _id: "request",
  workdayId: "monday",
  status: "denied",
  decidedAt: 40,
  reason: "Workday closed before approval",
});

const preview = await execute(true);
assert.equal(preview.changed, false);
assert.equal(preview.summary.opening.title, "Head of Manufacturing Excellence");
assert.equal(preview.summary.friday.plannedCreate, true);
assert.equal(find("friday"), undefined, "Dry run must not create the missing Friday workday");
assert.equal(find("email")!.date, "2026-10-19", "Dry run must not change the email");
assert.equal(find("monday")!.finishedAt, 40, "Dry run must not reopen the workday");

const result = await execute(false);
assert.equal(result.changed, true);
assert.equal(find("email")!.date, "2026-10-16");
assert.equal(find("receipt")!.workdayId, "friday");
assert.equal(find("round")!.sentAt, Date.parse("2026-10-16T23:59:59.999+05:30"));
assert.equal(find("friday")!.closureReason, "eod");
assert.equal(find("friday")!.completion.closureReason, "eod");
assert.equal(find("friday")!.jobs[0].jobId, "job");
assert.equal(find("friday")!.completion.jobs[0].activity.sent, 1);
assert.equal(find("monday")!.finishedAt, undefined);
assert.equal(find("monday")!.closureReason, undefined);
assert.equal(find("monday")!.completion, undefined);
assert.equal(find("mondayLead")!.finishedAt, undefined);
assert.equal(rows("taWorkdayLeads").find((row) => row.workdayId === "friday")!.finishedAt, Date.parse("2026-10-16T23:59:59.999+05:30"));
assert.equal(find("request")!.status, "pending");
assert.equal(find("request")!.reason, undefined);

await assert.rejects(() => execute(false), /Monday EOD|accepted original EOD|not an EOD-completed workday/);
console.log("Sanduni's late Friday EOD repair is scoped, dry-runnable and idempotently refuses a second write.");
