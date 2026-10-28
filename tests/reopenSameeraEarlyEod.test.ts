import assert from "node:assert/strict";
import { run } from "../convex/admin/reopenSameeraEarlyEod";
import { dailySendProblem } from "../src/lib/dailyEmail";

const realDateNow = Date.now;
Date.now = () => Date.parse("2026-10-28T06:00:00.000Z");
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
const jobId = "m17cw4va2wvhvc80bm9md3mbj98gc3c0";
put("users", { _id: "sameera", fullName: "A. Sameera", isActive: true });
put("users", { _id: "other", fullName: "Other TA", isActive: true });
put("jobs", { _id: jobId, title: "Executive - Industrial Engineering" });
put("taWorkdays", { _id: "day", userId: "sameera", date: "2026-10-28", finishedAt: 10, closureReason: "eod", completion: {}, jobs: [{ jobId }] });
put("dailyEmails", { _id: "email", userId: "sameera", jobId, date: "2026-10-28", submissionType: "eod", status: "accepted", finalizedAt: 10, acceptedAt: Date.now(), receiptId: "receipt", roundId: "round", applicationIds: ["app"] });
put("dailyEmails", { _id: "other-email", userId: "other", jobId, date: "2026-10-28", submissionType: "midday", status: "accepted", finalizedAt: 8, applicationIds: [] });
put("taWorkdayMail", { _id: "receipt", dailyEmailId: "email", workdayId: "day", userId: "sameera", jobId, status: "accepted", finalizedAt: 10 });
put("reviewRounds", { _id: "round", openingId: jobId, sentBy: "sameera", kind: "director", status: "awaiting", decisions: [], applicationIds: ["app"] });
put("applications", { _id: "app", jobId, ownerTaId: "sameera", currentStage: "second_shortlist" });
put("taWorkdayLeads", { _id: "lead", workdayId: "day", finishedAt: 10 });
put("taWorkdayRequests", { _id: "request", workdayId: "day", status: "denied", reason: "Workday closed before approval", decidedAt: 10 });
const execute = (dryRun: boolean) => (run as any)._handler({ db }, { dryRun });
const preview = await execute(true);
assert.equal(preview.changed, false);
assert.deepEqual(preview.summary.candidateIds, ["app"]);
assert.equal(preview.summary.otherTaEmailsOnOpening[0].id, "other-email");
assert.equal(get("email")!.recoveryReopenedAt, undefined);
get("app")!.ownerTaId = "other";
await assert.rejects(() => execute(false), /candidate has changed owner or stage/i);
get("app")!.ownerTaId = "sameera";
get("round")!.decisions = [{ applicationId: "app", decision: "yes" }];
await assert.rejects(() => execute(false), /received a decision/i);
get("round")!.decisions = [];
const result = await execute(false);
assert.equal(result.changed, true);
assert.equal(get("email")!.acceptedAt, preview.summary.acceptedAt);
assert.equal(get("email")!.recoveryReopenedAt, get("receipt")!.recoveryReopenedAt);
assert.equal(get("email")!.recoveryReopenedAt, get("round")!.recoveryReopenedAt);
assert.equal(get("day")!.finishedAt, undefined);
assert.equal(get("lead")!.finishedAt, undefined);
assert.equal(get("request")!.status, "pending");
assert.equal(get("other-email")!.recoveryReopenedAt, undefined);
const original = { status: "accepted" as const, submissionType: "eod" as const, parentId: undefined, recoveryReopenedAt: get("email")!.recoveryReopenedAt };
assert.equal(dailySendProblem([original], "midday", true), null);
await assert.rejects(() => execute(false), /Expected one finalized original EOD/);
Date.now = realDateNow;
console.log("Sameera's early EOD recovery is scoped, dry-runnable and preserves the other TA.");
