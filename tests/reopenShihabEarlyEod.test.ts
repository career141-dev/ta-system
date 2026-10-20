import assert from "node:assert/strict";
import { run } from "../convex/admin/reopenShihabEarlyEod";
import { dailySendProblem } from "../src/lib/dailyEmail";

type Row = Record<string, any>;
const data = new Map<string, Row[]>();
const rows = (name: string) => data.get(name) ?? (data.set(name, []), data.get(name)!);
const put = (name: string, row: Row) => rows(name).push(row);
const get = (id: string) => [...data.values()].flat().find(row => row._id === id);
const db = {
  get: async (id: string) => get(id) ?? null,
  normalizeId: (_table: string, id: string) => id,
  patch: async (id: string, patch: Row) => Object.assign(get(id)!, patch),
  query: (name: string) => {
    const conditions: Array<(row: Row) => boolean> = [];
    const query = {
      withIndex: (_index: string, build: (q: any) => unknown) => {
        const q = { eq: (field: string, value: unknown) => (conditions.push(row => row[field] === value), q) };
        build(q);
        return query;
      },
      collect: async () => rows(name).filter(row => conditions.every(check => check(row))),
    };
    return query;
  },
};
const jobId = "m17bhyypymgftktd7cv3w7sjfh8gkyst";
put("users", { _id: "shihab", email: "shihab@career141.com", isActive: true });
put("jobs", { _id: jobId, title: "Senior Operations Executive" });
put("taWorkdays", { _id: "day", userId: "shihab", date: "2026-10-20", finishedAt: 10, closureReason: "eod", completion: {}, jobs: [{ jobId }] });
put("dailyEmails", { _id: "email", userId: "shihab", jobId, date: "2026-10-20", submissionType: "eod", status: "accepted", finalizedAt: 10, acceptedAt: 9, receiptId: "receipt", roundId: "round", applicationIds: ["app"] });
put("taWorkdayMail", { _id: "receipt", dailyEmailId: "email", workdayId: "day", userId: "shihab", jobId, status: "accepted", finalizedAt: 10, applicationIds: ["app"] });
put("reviewRounds", { _id: "round", openingId: jobId, sentBy: "shihab", kind: "director", status: "awaiting", decisions: [], applicationIds: ["app"] });
put("applications", { _id: "app", jobId, ownerTaId: "shihab", currentStage: "second_shortlist" });
put("taWorkdayLeads", { _id: "lead", workdayId: "day", finishedAt: 10 });
put("taWorkdayRequests", { _id: "request", workdayId: "day", status: "denied", reason: "Workday closed before approval", decidedAt: 10 });
const execute = (dryRun: boolean) => (run as any)._handler({ db }, { dryRun });

const preview = await execute(true);
assert.equal(preview.changed, false);
assert.deepEqual(preview.summary.candidateIds, ["app"]);
assert.equal(get("email")!.recoveryReopenedAt, undefined);
const result = await execute(false);
assert.equal(result.changed, true);
assert.equal(get("email")!.acceptedAt, 9, "Actual send time remains intact");
assert.equal(get("email")!.recoveryReopenedAt, get("receipt")!.recoveryReopenedAt);
assert.equal(get("email")!.recoveryReopenedAt, get("round")!.recoveryReopenedAt);
assert.equal(get("day")!.finishedAt, undefined);
assert.equal(get("lead")!.finishedAt, undefined);
assert.equal(get("request")!.status, "pending");
const original = { status: "accepted" as const, submissionType: "eod" as const, parentId: undefined, recoveryReopenedAt: get("email")!.recoveryReopenedAt };
assert.equal(dailySendProblem([original], "midday", true), null);
assert.match(dailySendProblem([original], "eod", true)!, /midday email/);
assert.equal(dailySendProblem([original, { status: "accepted", submissionType: "midday", parentId: undefined, recoveryReopenedAt: undefined }], "eod", true), null);
await assert.rejects(() => execute(false), /Today's closed workday|Expected one finalized original EOD/);
console.log("Shihab's early EOD recovery keeps the sent audit, previews, reopens and refuses a second write.");
