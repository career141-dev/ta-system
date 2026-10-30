import assert from "node:assert/strict";
import * as mail from "../convex/ta/dailyEmails";
import { finalizeDailyEmail } from "../convex/lib/dailyEmail";
import { dailySendProblem, sameCandidateList } from "../src/lib/dailyEmail";
import { workdayDate } from "../src/lib/workday";
import { requiredChecks } from "../convex/lib/workdayChecks";
import { matchReviewReply } from "../src/lib/routing";
import { flagStuckSends, normalizeRetention, purgeExpired } from "../convex/ta/eodCopies";
import { assign as assignLocation } from "../convex/ta/workLocations";
import { emailPreflight } from "../convex/ta/workdays";

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
  delete: async (id: string) => { for (const table of tables.values()) { const index = table.findIndex(r => r._id === id); if (index >= 0) table.splice(index, 1); } },
  query: (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let desc = false;
    const query = {
      withIndex: (_: string, apply: (q: any) => unknown) => {
        const builder = { eq: (key: string, value: unknown) => { predicates.push(r => r[key] === value); return builder; },
          gte: (key: string, value: number) => { predicates.push(r => r[key] >= value); return builder; },
          gt: (key: string, value: number) => { predicates.push(r => r[key] > value); return builder; },
          lt: (key: string, value: number) => { predicates.push(r => r[key] < value); return builder; },
          lte: (key: string, value: number) => { predicates.push(r => r[key] <= value); return builder; } };
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
const deletedFiles: string[] = [];
const ctx = { db, storage: { getUrl: async (id: string) => `http://127.0.0.1/files/${id}`, delete: async (id: string) => { deletedFiles.push(id); } }, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null, runAt: async () => null } } as any;
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
const begin = (ids: string[], draftId?: string, extra: Row = {}) => run("begin", { actorId: "ta", jobId: "job", submissionType: draftId ? "midday" : "eod", draftId, previewConfirmed: true,
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
  assert.equal((await db.get("day"))?.finishedAt, now, "Original 100% EOD finishes the clock atomically");
  const originalFinish = now;
  assert.deepEqual(rows("reviewRounds")[1].applicationIds, ["c", "d", "e"], "EOD includes only the three candidates after midday");
  await assert.rejects(() => begin([]), /already been sent/);
  await assert.rejects(() => run("createDraft", { actorId: "ta", jobId: "job" }), /already been sent/);
  await assert.rejects(() => begin(["c"], undefined, { parentId: eod.id }), /original candidates/);
  await assert.rejects(() => begin(["c", "d", "e"], undefined, { parentId: eod.id, previewConfirmed: false }), /preview/);
  now += 30 * 86400000;
  const correction = await begin(["c", "d", "e"], undefined, { parentId: eod.id });
  await run("result", { id: correction.id, status: "accepted" });
  assert.equal(rows("reviewRounds").length, 2, "Corrections reuse the original round");
  assert.equal(rows("reviewRounds")[1].revisedAt.length, 1);
  await finalizeDailyEmail(ctx, await db.get(correction.id) as any);
  assert.equal(rows("reviewRounds")[1].revisedAt.length, 1);
  assert.equal(rows("dailyEmails").find(e => e._id === correction.id)!.expiresAt, now + 31 * 86400000);
  assert.equal((await db.get("day"))?.finishedAt, originalFinish, "Resends never retime the workday");
  assert.equal((await db.get(correction.id))?.date, workdayDate(originalFinish), "Resends preserve original work date");
  assert.equal((await run("sent", { actorId: "ta" })).length, 2, "Backups are selected by send time");
  assert.equal((await run("sent", { actorId: "other" })).length, 0);
  now += 2 * 86400000;
  await db.patch(eod.id, { snapshot: undefined });
  const file = { id: "savedFile", name: "Original CV.pdf", applicationId: "c" };
  put("dailyEmailAttachments", { _id: file.id, userId: "ta", jobId: "job", applicationId: "c", name: file.name, storageId: "original-pdf", createdAt: originalFinish, expiresAt: now });
  const retainedSnapshot = { ...(await db.get(correction.id))!.snapshot, attachments: [file] };
  await db.patch(correction.id, { snapshot: retainedSnapshot, expiresAt: now - 1 });
  await (normalizeRetention as any)._handler(ctx, { dryRun: true });
  assert.equal((await db.get(correction.id))!.expiresAt, now - 1, "Retention migration dry run never writes");
  await (normalizeRetention as any)._handler(ctx, { dryRun: false });
  assert.equal((await db.get(correction.id))!.expiresAt, (await db.get(correction.id))!.acceptedAt + 31 * 86400000);
  assert.equal((await run("attachment", { actorId: "ta", emailId: correction.id, attachmentId: file.id })).url, "http://127.0.0.1/files/original-pdf");
  await assert.rejects(() => run("attachment", { actorId: "other", emailId: correction.id, attachmentId: file.id }), /another TA/);
  const later = await begin(["c", "d", "e"], undefined, { parentId: correction.id, snapshot: retainedSnapshot });
  await run("result", { id: later.id, status: "accepted" });
  assert.equal((await db.get(file.id))!.expiresAt, now + 31 * 86400000, "Resends retain their exact saved PDFs for a fresh 31 days");
  assert.equal((await db.get(later.id))?.parentId, eod.id, "A retained revision remains correctable after original content expires");
  assert.equal(rows("reviewRounds").length, 2);
  put("eodEmailCopies", { _id: "legacyCopy", sentBy: "ta", openingId: "job", roundId: "legacyRound", version: 1,
    sentAt: now - 1000, expiresAt: now + 86400000, subject: "Legacy activity", introText: "Hello", outroText: "Thanks", researchLink: link,
    applicationIds: [], rows: [], effort: { date: "2026-10-16", assignee: "ta", hundredOrFollowUp: "Follow-up" }, to: ["director@example.invalid"], cc: [], extraTo: [], extraCc: [], removed: [] });
  await (normalizeRetention as any)._handler(ctx, { dryRun: true });
  assert.equal(rows("dailyEmails").some(e => e.legacyCopyId === "legacyCopy"), false);
  await (normalizeRetention as any)._handler(ctx, { dryRun: false });
  await (normalizeRetention as any)._handler(ctx, { dryRun: false });
  assert.equal(rows("dailyEmails").filter(e => e.legacyCopyId === "legacyCopy").length, 1, "Legacy copy import is idempotent and never sends mail");
  assert.equal(rows("reviewRounds").length, 2);
  now += 86400000;
  await assert.rejects(() => run("saveDraft", { actorId: "ta", id: first, revision: 2, fields: {} }), /unsent/);
  assert.equal((await run("list", { actorId: "other", jobId: "job" })).length, 0, "TAs cannot read another sender's copies");
  now += 32 * 86400000;
  assert.equal((await run("list", { actorId: "ta", jobId: "job" }))[0].snapshot, undefined, "Expired content is hidden immediately");
  await assert.rejects(() => begin(["c", "d", "e"], undefined, { parentId: eod.id }), /retained EOD/);
  await (purgeExpired as any)._handler(ctx, {});
  assert.deepEqual(deletedFiles, ["original-pdf"], "Independent PDFs are removed only after every backup reference expires");
  console.log("Daily email drafts, ordering, ownership, candidates, failures, reconciliation, corrections and retention passed.");
  // One job, two locations: exact candidate rosters, independent send locks,
  // and one attendance clock closed only by the final location's accepted EOD.
  tables.clear();
  seedUser("ta"); seedUser("other"); seedUser("lead", "ta_lead");
  const workLocations = [{ id: "mumbai", name: "Mumbai", vacancies: 2 }, { id: "delhi", name: "Delhi", vacancies: 1 }];
  put("jobs", { _id: "job", title: "Engineer", taLeadId: "lead", assignedTaIds: ["ta", "other"], workLocations });
  put("taWorkdays", { _id: "day", userId: "ta", date: workdayDate(now), startedAt: now, jobs: [{ jobId: "job", workType: "100%", addedAt: now, leadId: "lead", modeHistory: [], workLocationIds: ["mumbai", "delhi"] }] });
  put("dailyEmailPolicy", { _id: "policy", key: "midday", requiredFrom: workdayDate(now) });
  candidate("m"); candidate("d"); candidate("unknown");
  await db.patch("m", { workLocationId: "mumbai" }); await db.patch("d", { workLocationId: "delhi" });
  await assert.rejects(() => run("createDraft", { actorId: "ta", jobId: "job" }), /Select an active work location/);
  const mDraft = await run("createDraft", { actorId: "ta", jobId: "job", workLocationId: "mumbai" });
  const dDraft = await run("createDraft", { actorId: "ta", jobId: "job", workLocationId: "delhi" });
  assert.equal((await db.get(mDraft))!.number, 1);
  assert.equal((await db.get(dDraft))!.number, 1, "Midday numbering starts independently in Delhi");
  await assert.rejects(() => begin(["m"], dDraft, { workLocationId: "mumbai" }), /draft changed/);
  await assert.rejects(() => begin(["m", "d"], mDraft, { workLocationId: "mumbai" }), /candidate list changed/);
  await begin(["m"], mDraft, { workLocationId: "mumbai" }); await run("result", { id: mDraft, status: "accepted" });
  await assert.rejects(() => begin([], undefined, { workLocationId: "delhi" }), /midday/);
  await begin(["d"], dDraft, { workLocationId: "delhi" }); await run("result", { id: dDraft, status: "accepted" });
  candidate("m-eod"); candidate("d-eod");
  await db.patch("m-eod", { workLocationId: "mumbai" }); await db.patch("d-eod", { workLocationId: "delhi" });
  checks = await requiredChecks(ctx, await db.get("day") as any, (await db.get("day"))!.jobs[0]);
  for (const check of checks.eodChecks.filter(c => c.exceptionVersion)) put("taWorkdayExceptions", { _id: `exception:${check.key}`, workdayId: "day", jobId: "job", key: check.key,
    version: check.exceptionVersion, action: "submit", at: now, by: "ta", reason: "Synthetic setup exception" });
  await assert.rejects(() => begin(["m-eod", "d-eod"], undefined, { workLocationId: "mumbai" }), /candidate list changed/);
  put("linkVault", { _id: "delhi-link", openingId: "job", addedBy: "ta", workLocationId: "delhi" });
  await assert.rejects(() => begin(["m-eod"], undefined, { workLocationId: "mumbai", snapshot: { ...snapshot(["m-eod"]), workbookLinkIds: ["delhi-link"] } }), /workbook row changed location/);
  const mEod = await begin(["m-eod"], undefined, { workLocationId: "mumbai" });
  await assert.rejects(() => begin(["m-eod"], undefined, { workLocationId: "mumbai" }), /reconciliation|still sending/);
  // A send whose result never came back is flagged for the Lead instead of blocking silently (29 Oct).
  now += 16 * 60000;
  await (flagStuckSends as any)._handler(ctx, {});
  assert.equal((await db.get(mEod.id))!.status, "uncertain", "A send stuck in sending is flagged uncertain");
  assert.equal((await db.get((await db.get(mEod.id))!.receiptId))!.status, "uncertain", "Its receipt follows");
  now -= 16 * 60000;
  const dEod = await begin(["d-eod"], undefined, { workLocationId: "delhi" });
  await run("result", { id: dEod.id, status: "accepted" });
  assert.equal((await db.get("day"))!.finishedAt, undefined, "Delhi sent; attendance remains open for Mumbai");
  checks = await requiredChecks(ctx, await db.get("day") as any, (await db.get("day"))!.jobs[0]);
  assert.equal(checks.checks.find(c => c.key.startsWith("daily_email:"))?.status, "incomplete");
  await run("result", { id: mEod.id, status: "uncertain" });
  await assert.rejects(() => begin([], undefined, { workLocationId: "delhi" }), /already been sent/);
  now += 600000;
  await run("reconcile", { actorId: "lead", id: mEod.id, accepted: true, reason: "Verified synthetic Mumbai message" });
  assert.equal((await db.get("day"))!.finishedAt, now, "Final location closes the single attendance clock");
  assert.equal((await db.get(mEod.id))!.workLocationName, "Mumbai");
  assert.equal(rows("reviewRounds").find(r => r.workLocationId === "mumbai" && r.submissionType === "eod")!.applicationIds.join(), "m-eod");
  await assert.rejects(() => begin(["m-eod"], undefined, { parentId: mEod.id, workLocationId: "delhi" }), /original work location/);
  const revisedMumbai = await begin(["m-eod"], undefined, { parentId: mEod.id, workLocationId: "mumbai" });
  await run("result", { id: revisedMumbai.id, status: "accepted" });
  // A new date with no CVs supports activity-only reports for configured locations.
  now += 86400000;
  put("taWorkdays", { _id: "next-day", userId: "ta", date: workdayDate(now), startedAt: now, jobs: [{ jobId: "job", workType: "100%", addedAt: now, modeHistory: [], workLocationIds: ["mumbai", "delhi"] }] });
  await db.delete("policy");
  put("dailyEmails", { _id: "legacy-pending", jobId: "job", userId: "ta", date: "2020-01-01", submissionType: "eod", status: "uncertain", applicationIds: [] });
  await assert.rejects(() => begin([], undefined, { workLocationId: "mumbai" }), /reconciliation/);
  await db.delete("legacy-pending");
  checks = await requiredChecks(ctx, await db.get("next-day") as any, (await db.get("next-day"))!.jobs[0]);
  for (const check of checks.eodChecks.filter(c => c.exceptionVersion)) put("taWorkdayExceptions", { _id: `next-exception:${check.key}`, workdayId: "next-day", jobId: "job", key: check.key,
    version: check.exceptionVersion, action: "submit", at: now, by: "ta", reason: "Synthetic next-day setup exception" });
  const activity = await begin([], undefined, { workLocationId: "mumbai" });
  await run("result", { id: activity.id, status: "accepted" });
  assert.equal((await db.get("next-day"))!.finishedAt, undefined);
  const preflight = await (emailPreflight as any)._handler(ctx, { actorId: "ta", jobId: "job", workLocationId: "delhi", link, confirmed: true });
  assert.equal(preflight.ok, true, "The real EOD preflight leaves Delhi sendable after Mumbai's activity-only report");
  put("linkVault", { _id: "unknown-link", openingId: "job", addedBy: "ta", candidateId: "c:unknown", level: 1 });
  const assign = (actorId: string, extra: Row = {}) => (assignLocation as any)._handler(ctx, { actorId, jobId: "job", locationId: "delhi", linkId: "unknown-link", ...extra });
  await assert.rejects(() => assign("other"), /own sourcing/);
  await assert.rejects(() => assign("ta", { locationId: "forged" }), /Select an active/);
  await assign("ta");
  assert.equal((await db.get("unknown"))!.workLocationId, "delhi", "Assignment updates the existing application atomically");
  assert.equal((await db.get("unknown-link"))!.workLocationId, "delhi");
  assert.equal((await db.get("unknown-link"))!.level, 1);
  assert.equal(rows("applications").filter(a => a.candidateId === "c:unknown").length, 1);
  await assert.rejects(() => assign("ta", { linkId: undefined, applicationId: "m-eod" }), /already been sent/);
  put("linkVault", { _id: "unknown-link-2", openingId: "job", addedBy: "ta", level: 1 });
  await assign("ta", { linkId: "unknown-link-2" });
  assert.equal((await db.get("unknown-link-2"))!.level, 1, "Moving the same legacy batch reuses its imported level");
  assert.equal(rows("activityLog").filter(r => r.action === "work_location_assigned").length, 2);
  // 23 Oct: a non-location 100% job can close with links and activity alone.
  now += 86400000;
  await db.patch("job", { workLocations: undefined });
  tables.set("applications", []);
  put("taWorkdays", { _id: "activity-100-day", userId: "ta", date: workdayDate(now), startedAt: now,
    jobs: [{ jobId: "job", workType: "100%", addedAt: now, leadId: "lead", modeHistory: [] }] });
  await assert.rejects(() => begin([]), /Today's Checks/, "100% setup requirements still apply without CVs");
  checks = await requiredChecks(ctx, await db.get("activity-100-day") as any, (await db.get("activity-100-day"))!.jobs[0]);
  for (const check of checks.eodChecks.filter(c => c.exceptionVersion)) put("taWorkdayExceptions", { _id: `activity-exception:${check.key}`, workdayId: "activity-100-day", jobId: "job", key: check.key,
    version: check.exceptionVersion, action: "submit", at: now, by: "ta", reason: "Synthetic setup exception" });
  const roundCount = rows("reviewRounds").length;
  const emptyEod = await begin([], undefined, { snapshot: { ...snapshot([]), attachmentNames: [] } });
  await run("result", { id: emptyEod.id, status: "accepted" });
  assert.equal((await db.get("activity-100-day"))!.finishedAt, now, "100% activity-only EOD completes attendance");
  assert.equal(rows("reviewRounds").length, roundCount, "No candidate round is created without CVs");
  await assert.rejects(() => begin([]), /already been sent/);
  console.log("Location rosters, independent drafts/send guards, uncertainty, corrections and activity-only EOD passed.");
} finally { Date.now = originalNow; }
