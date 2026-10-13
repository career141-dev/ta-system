import assert from "node:assert/strict";
import type { Application, Candidate, LinkVaultEntry, ReviewRound } from "@/data/types";
import { eyeMarkedHasCv, eyeMarkedItems, eyeMarkedProgress } from "@/lib/eyeMarked";
import { checkEmail } from "../convex/ta/eyeMarked";

const row = { id: "link", openingId: "opening", addedBy: "ta", name: null,
  linkedinUrl: "https://linkedin.com/in/person", isEyeMarked: true,
  candidateId: null, outcome: "no_contact", conversationLog: [],
  title: null, company: null, phoneNumber: null, phoneSource: null,
  sourcingChannel: "HH", createdAt: 1,
} satisfies LinkVaultEntry;
const app = { id: "app", openingId: "opening", candidateId: "candidate", stage: "ta_follow_up" } as Application;
const cv = { id: "candidate", fullName: "Candidate", cvFileName: "cv.pdf" } as Candidate;
const progress = (patch: Partial<LinkVaultEntry> = {}, application?: Application, candidate?: Candidate, sent = false) =>
  eyeMarkedProgress({ ...row, ...patch }, application, candidate, sent);

assert.equal(progress().blocked, true, "a bare marked LinkedIn link requires contact");
assert.equal(progress().name, row.linkedinUrl, "a nameless profile remains identifiable");
assert.equal(progress({ outcome: "contacted" }).blocked, false, "waiting for an external CV must allow sending");
assert.equal(progress({ outcome: "responded" }).complete, false, "a response is not submission");
assert.equal(progress({ outcome: "unreachable" }).blocked, false, "a recorded failed contact attempt allows the daily report");
assert.equal(progress({ outcome: "declined" }).complete, true, "declined candidates need no pipeline move");
assert.equal(progress({ conversationLog: [{ at: 1, by: "ta", channel: "phone", note: "Asked for CV" }] }).blocked, false);
assert.equal(progress({ outcome: "cv_received" }).blocked, true, "received CV needs linking and pipeline entry");
assert.equal(progress({ outcome: "shortlisted" }).blocked, true, "changing the Excel outcome alone cannot satisfy the gate");
assert.equal(progress({}, app, cv).blocked, true, "a received CV in follow-up requires Director Review");
assert.equal(progress({}, { ...app, stage: "director_review" }, cv).complete, true);
assert.equal(progress({}, { ...app, stage: "director_review" }).blocked, true, "Director Review without an actual CV is not ready");
assert.equal(progress({}, { ...app, stage: "director_review" }, { ...cv, cvFileMissing: true }).blocked, true);
assert.equal(progress({}, app, cv, true).complete, true, "prior submissions never require resubmission");
assert.equal(progress({}, { ...app, stage: "director_shortlist" }, cv).complete, true);
assert.equal(progress({}, { ...app, stage: "rejected" }, cv).complete, true);
assert.equal(progress({}, { ...app, stage: "dropped_out" }, cv).complete, true);

const linkedRow = { ...row, candidateId: "candidate" };
const round = { kind: "director", applicationIds: ["app"] } as ReviewRound;
assert.equal(eyeMarkedItems([linkedRow], [app], [cv], [round])[0].complete, true);
assert.equal(eyeMarkedItems([linkedRow], [{ ...app, openingId: "other" }], [cv], [round])[0].complete, false, "another opening's application cannot satisfy the requirement");
assert.equal(eyeMarkedItems([{ ...row, isEyeMarked: false }], [], [], []).length, 0, "unmarking removes the requirement");
const fifty = Array.from({ length: 50 }, (_, i) => ({ ...row, id: `link-${i}` }));
assert.equal(eyeMarkedItems(fifty, [], [], []).filter((item) => item.blocked).length, 50, "all marked profiles are checked, not only the first page");
assert.equal(progress({}, { ...app, stage: "placed" }, cv).complete, true);
assert.equal(eyeMarkedHasCv(undefined, undefined), false, "a bare LinkedIn link cannot enter the pipeline");
assert.equal(eyeMarkedHasCv(cv, undefined), true);
assert.equal(eyeMarkedHasCv({ ...cv, cvFileMissing: true }, undefined), false);

// Exercise the actual backend query against synthetic rows: no backend or messages.
type Row = Record<string, any>;
const tables: Record<string, Row[]> = {
  users: [{ _id: "ta", role: "recruiter", taRole: "ta", isActive: true, isOnboarded: true }],
  jobs: [{ _id: "opening", assignedTaIds: ["ta"] }],
  jobAssignments: [],
  linkVault: fifty.map((r) => ({ ...r, _id: r.id })),
  applications: [], candidates: [], reviewRounds: [],
};
const ctx = {
  auth: { getUserIdentity: async () => null },
  db: {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    query: (table: string) => {
      const predicates: ((row: Row) => boolean)[] = [];
      const query = {
        withIndex: (_name: string, callback: (builder: any) => unknown) => {
          const builder = { eq: (key: string, value: unknown) => { predicates.push((r) => r[key] === value); return builder; } };
          callback(builder); return query;
        },
        filter: (callback: (builder: any) => (row: Row) => boolean) => {
          predicates.push(callback({ field: (key: string) => key,
            eq: (key: string, value: unknown) => (r: Row) => r[key] === value,
            and: (...parts: ((r: Row) => boolean)[]) => (r: Row) => parts.every((p) => p(r)),
            or: (...parts: ((r: Row) => boolean)[]) => (r: Row) => parts.some((p) => p(r)),
          })); return query;
        },
        collect: async () => (tables[table] ?? []).filter((r) => predicates.every((p) => p(r))),
        first: async () => (await query.collect())[0] ?? null,
      };
      return query;
    },
  },
};
const check = () => (checkEmail as any)._handler(ctx, { actorId: "ta", openingId: "opening" });
assert.deepEqual(await check(), { ok: false, outstanding: 50 });
tables.linkVault.forEach((r) => { r.outcome = "contacted"; });
assert.deepEqual(await check(), { ok: true, outstanding: 0 }, "contacted profiles waiting on CVs allow the email");
tables.linkVault.push({ ...row, _id: "other-ta", addedBy: "other" });
assert.deepEqual(await check(), { ok: true, outstanding: 0 }, "another TA's marked rows cannot block this TA");
tables.linkVault[0].candidateId = "candidate";
tables.linkVault[0].outcome = "cv_received";
tables.candidates.push({ ...cv, _id: "candidate" });
tables.applications.push({ _id: "app", jobId: "opening", candidateId: "candidate", currentStage: "follow_up" });
assert.deepEqual(await check(), { ok: false, outstanding: 1 });
tables.applications[0].currentStage = "second_shortlist";
assert.deepEqual(await check(), { ok: true, outstanding: 0 });
tables.applications[0].currentStage = "follow_up";
tables.reviewRounds.push({ openingId: "opening", kind: "director", applicationIds: ["app"] });
assert.deepEqual(await check(), { ok: true, outstanding: 0 }, "a prior submission remains complete after a stage change");
tables.reviewRounds = [];
tables.linkVault[0].isEyeMarked = false;
assert.deepEqual(await check(), { ok: true, outstanding: 0 });
tables.jobs[0].assignedTaIds = [];
await assert.rejects(check, /not assigned/, "the query enforces opening access");
console.log("Eye-marked progress and backend email gate passed.");
