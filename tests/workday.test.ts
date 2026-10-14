import assert from "node:assert/strict";
import {
  applyCarryForwards,
  completionBlockers,
  validateCarry,
  workdayDate,
  type WorkdayCheck,
} from "../src/lib/workday";
import * as workdays from "../convex/ta/workdays";
import { assertWorkdayScope } from "../convex/lib/workdayScope";
import * as openings from "../convex/ta/openings";
import { recordJdReview } from "../convex/lib/workdayChecks";

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
      paginate: async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
        const all = await query.collect(); const start = Number(cursor) || 0;
        return { page: all.slice(start, start + numItems), isDone: start + numItems >= all.length, continueCursor: String(start + numItems) };
      },
    };
    return query;
  },
};
const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAt: async () => null, runAfter: async () => null } } as any;
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
  assert.equal(await run("suggestionsCheck", { actorId: "ta", jobId: "job1" }), null, "No explanation form before starting work");
  assert.equal(rows("taWorkdays").length, 0);
  assert.equal(workdayDate(Date.parse("2026-10-12T20:00:00Z")), "2026-10-13");
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
    /Add this assigned position to your workday first/,
  );
  const addedSecond = await run("addPosition", {
    actorId: "ta",
    workdayId: day.id,
    jobId: "job2",
    workType: "Add-on",
  });
  assert.equal(addedSecond.pending, false);
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
  // New mandatory setup is evaluated from saved evidence, not a browser tick.
  const blocked = await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.some((b: string) => b.includes("Excel")));
  assert.ok(blocked.blockers.some((b: string) => b.includes("Job description")));
  await assert.rejects(() => run("saveCheck", { actorId: "ta", jobId: "job1", kind: "jd" }), /approve the job description/);
  const suggestionsCheck = () => run("suggestionsCheck", { actorId: "ta", jobId: "job1" });
  for (const confirmed of [undefined, false]) {
    await assert.rejects(() => run("saveCheck", { actorId: "ta", jobId: "job1", kind: "chatgpt", link: "https://chatgpt.com/share/12345678", ...(confirmed === undefined ? {} : { confirmed }) }), /Confirm you opened this link/, "Saving cannot report success for an unconfirmed link");
  }
  put("taWorkdayTaskEvents", { _id: "paused:suggestions", workdayId: day.id, jobId: "job1", userId: "ta", key: "suggestions:job1", label: "Suggestions reviewed", href: "/openings/job1/hh/suggestions", kind: "details", status: "incomplete", at: clock });
  assert.ok(!(await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.some((c: Row) => c.key.startsWith("suggestions:")), "Historical events cannot restore the paused Suggestions check");
  assert.ok(!(await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).blockers.some((b: string) => b.includes("Suggestions")), "Suggestions no longer blocks email");
  assert.equal((await suggestionsCheck()).needsEmptySuggestionsReason, false, "An empty page without a successful run must not offer the form");
  await assert.rejects(() => run("saveCheck", { actorId: "ta", jobId: "job1", kind: "emptySuggestions", reason: "No results" }), /Only a successful empty search/);
  await run("recordSourcingRun", { jobId: "job1", userId: "support", round: 1, count: 0 });
  assert.equal((await suggestionsCheck()).needsEmptySuggestionsReason, false, "Another TA's empty run does not qualify");
  assert.equal(await run("suggestionsCheck", { actorId: "ta", jobId: "job3" }), null, "An opening outside the active workday does not offer the form");
  put("profileSuggestions", { _id: "explanation:profile", openingId: "job1", generatedFor: "ta", round: 1, generatedAt: clock, status: "dismissed" });
  await run("recordSourcingRun", { jobId: "job1", userId: "ta", round: 1, count: 1 });
  assert.equal((await suggestionsCheck()).needsEmptySuggestionsReason, false, "A fully dismissed round is not an empty search");
  await assert.rejects(() => run("saveCheck", { actorId: "ta", jobId: "job1", kind: "emptySuggestions", reason: "No results" }), /Only a successful empty search/);
  clock++;
  await run("recordSourcingRun", { jobId: "job1", userId: "ta", round: 2, count: 0 });
  assert.equal((await suggestionsCheck()).needsEmptySuggestionsReason, true, "An empty later round qualifies even when older profiles remain visible");
  await run("saveCheck", { actorId: "ta", jobId: "job1", kind: "emptySuggestions", reason: "No new profiles in round two" });
  assert.equal((await suggestionsCheck()).needsEmptySuggestionsReason, false, "Saving hides the form for the applicable run");
  clock++;
  await run("recordSourcingRun", { jobId: "job1", userId: "ta", round: 3, count: 0 });
  assert.equal((await suggestionsCheck()).needsEmptySuggestionsReason, true, "A new empty round requires its own explanation");
  tables.set("profileSuggestions", []);
  tables.set("taSourcingRuns", []);
  for (const [actorId, jobId] of [["ta", "job1"], ["ta", "job2"], ["support", "job1"], ["support", "job3"]]) {
    await db.patch(jobId, { jobDescription: `Synthetic JD for ${jobId}`, jdStatus: "approved" });
    await run("saveCheck", { actorId, jobId, kind: "jd" });
    if (!rows("researchReports").some(r => r.openingId === jobId)) put("researchReports", { _id: `research:${jobId}`, openingId: jobId, fields: {}, generatedAt: clock });
    put("jobPosts", { _id: `linkedin:${jobId}:${actorId}`, openingId: jobId, channel: "LinkedIn", externalUrl: "https://www.linkedin.com/jobs/view/123", postedAt: clock });
    for (let i = 0; i < 3; i++) put("linkVault", { _id: `setup:${actorId}:${jobId}:${i}`, openingId: jobId, addedBy: actorId, createdAt: clock + i, linkedinUrl: `https://linkedin.com/in/${actorId}-${jobId}-${i}`, outcome: "contacted", conversationLog: [], isEyeMarked: false });
    await run("recordSourcingRun", { jobId, userId: actorId, round: 1, count: 0 });
    await run("saveCheck", { actorId, jobId, kind: "research", reasons: Object.fromEntries(["similarDesignation", "websiteLink", "servicesProvider", "country", "location", "competitors", "socialMedia", "companyOverview"].map(k => [k, "Not available in synthetic fixture"])) });
    await run("saveCheck", { actorId, jobId, kind: "emptySuggestions", reason: "No synthetic results" });
    await run("saveCheck", { actorId, jobId, kind: "noCandidates", reason: "No suitable synthetic candidates" });
    await run("saveCheck", { actorId, jobId, kind: "chatgpt", link: "https://chatgpt.com/share/12345678", confirmed: true });
  }
  // The temporary send gate depends only on the four setup requirements.
  const savedPosts = [...rows("jobPosts")];
  tables.set("jobPosts", savedPosts.filter(p => p.openingId !== "job1"));
  const savedNotes = rows("taWorkdayCheckNotes").find(n => n.userId === "ta" && n.jobId === "job1")!;
  const savedReason = savedNotes.noCandidateReason;
  await db.patch(savedNotes._id, { noCandidateReason: undefined });
  put("applications", { _id: "temporary:unreviewed", jobId: "job1", candidateId: "temporary:candidate", currentStage: "new_cvs", sourceChannel: "SCOOP", createdAt: clock, lastStageChangedAt: clock });
  assert.equal((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).ok, true, "Reviewed JD/research, three profiles and a confirmed share link allow EOD despite missing LinkedIn post, no director candidate and pending CV reviews");
  const activityMail = await run("beginMail", { actorId: "ta", jobId: "job1", applicationIds: [], subject: "Synthetic progress update", sentTo: "director@example.invalid", researchLink: "https://chatgpt.com/share/12345678" });
  assert.ok(activityMail.id, "Reservation uses the same simplified gate as preflight");
  await run("mailResult", { id: activityMail.id, status: "failed" });
  // Match the reported sidebar: incomplete candidate progress, a ready Director
  // Review candidate, no LinkedIn post, and all four required setup checks ticked.
  put("candidates", { _id: "temporary:readyCandidate", fullName: "Synthetic ready candidate" });
  put("applications", { _id: "temporary:followup", jobId: "job1", candidateId: "temporary:missingDetails", ownerTaId: "ta", currentStage: "follow_up", sourceChannel: "L", shortlistedAt: clock, lastStageChangedAt: clock });
  put("applications", { _id: "temporary:ready", jobId: "job1", candidateId: "temporary:readyCandidate", ownerTaId: "ta", currentStage: "second_shortlist", sourceChannel: "SCOOP", shortlistedAt: clock, lastStageChangedAt: clock });
  const reportedJob = (await run("dashboard", { actorId: "ta" })).active.jobs[0];
  assert.ok(reportedJob.checks.some((c: Row) => c.key.startsWith("candidate:") && c.status !== "complete"));
  assert.ok(reportedJob.checks.some((c: Row) => c.key.startsWith("linkedin_post:") && c.status !== "complete"));
  assert.ok(reportedJob.eodChecks.every((c: Row) => c.status === "complete"));
  assert.equal((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).ok, true, "The four ticked checks permit sending with outstanding candidate progress");
  const candidateMail = await run("beginMail", { actorId: "ta", jobId: "job1", applicationIds: ["temporary:ready"], subject: "Synthetic Director Review update", sentTo: "director@example.invalid", researchLink: "https://chatgpt.com/share/12345678" });
  assert.ok(candidateMail.id);
  await run("mailResult", { id: candidateMail.id, status: "failed" });
  tables.set("applications", rows("applications").filter(a => !["temporary:followup", "temporary:ready"].includes(a._id)));
  tables.set("candidates", rows("candidates").filter(c => c._id !== "temporary:readyCandidate"));
  tables.set("applications", rows("applications").filter(a => a._id !== "temporary:unreviewed"));
  tables.set("jobPosts", savedPosts);
  await db.patch(savedNotes._id, { noCandidateReason: savedReason });
  await workdays.refreshWorkdayChecks(ctx, "job1" as any, "ta" as any);
  let checkedJob = (await run("dashboard", { actorId: "ta" })).active.jobs[0];
  const confirmedAt = checkedJob.checks.find((c: Row) => c.key.startsWith("chatgpt:")).completedAt;
  assert.equal(checkedJob.checks.find((c: Row) => c.key.startsWith("chatgpt:")).status, "complete", "Confirmed saves immediately complete the same check the sidebar reads");
  assert.ok(confirmedAt);
  await assert.rejects(() => run("saveCheck", { actorId: "ta", jobId: "job1", kind: "chatgpt", link: "https://chatgpt.com/share/12345678", confirmed: false }), /Confirm you opened this link/);
  assert.equal((await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("chatgpt:")).completedAt, confirmedAt, "A refused unconfirmed save must not erase an existing confirmation");
  const eventsBefore = rows("taWorkdayTaskEvents").length;
  await workdays.refreshWorkdayChecks(ctx, "job1" as any);
  assert.equal(rows("taWorkdayTaskEvents").length, eventsBefore, "Repeated evaluation does not duplicate events");
  clock += 5;
  await run("saveCheck", { actorId: "ta", jobId: "job1", kind: "chatgpt", link: "https://chatgpt.com/share/12345678", confirmed: true });
  checkedJob = (await run("dashboard", { actorId: "ta" })).active.jobs[0];
  assert.equal(checkedJob.checks.find((c: Row) => c.key.startsWith("chatgpt:")).completedAt, confirmedAt, "Repeated confirmations keep the completion time");
  const jdAt = checkedJob.checks.find((c: Row) => c.key.startsWith("jd_review:")).completedAt;
  await run("saveCheck", { actorId: "ta", jobId: "job1", kind: "jd" });
  assert.equal((await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:")).completedAt, jdAt);
  put("jobAssignments", { _id: "jdAssignment", jobId: "job1", userId: "ta", assignmentRole: "primary_recruiter", isActive: true });
  clock += 10;
  await (openings.saveJd as any)._handler(ctx, { actorId: "ta", openingId: "job1", jdMarkdown: "Changed synthetic JD" });
  for (const actorId of ["ta", "support"]) {
    const jdCheck = (await run("dashboard", { actorId })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:"));
    assert.equal(jdCheck.status, "incomplete", "A shared JD edit reopens every TA's review");
    assert.ok(jdCheck.events.some((e: Row) => e.status === "incomplete"));
  }
  assert.equal((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).ok, false);
  assert.equal((await run("finish", { actorId: "ta", workdayId: day.id })).ok, false);
  await (openings.saveJd as any)._handler(ctx, { actorId: "ta", openingId: "job1", jdMarkdown: "Synthetic JD for job1" });
  assert.equal((await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:")).status, "incomplete", "Restoring old text must not restore an invalidated review");
  await (openings.approveJd as any)._handler(ctx, { actorId: "ta", openingId: "job1" });
  const approvedCheck = (await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:"));
  assert.equal(approvedCheck.status, "complete", "The existing approval action records the approving TA's review");
  assert.equal(approvedCheck.completedAt, clock);
  assert.equal(approvedCheck.completedBy, "ta");
  assert.equal((await run("dashboard", { actorId: "support" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:")).status, "incomplete", "Another TA's approval does not confirm this TA's review");
  await run("saveCheck", { actorId: "support", jobId: "job1", kind: "jd" });
  const leadJd = (await run("dashboard", { actorId: "lead", detail: true })).team.find((d: Row) => d.userId === "ta").jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:"));
  assert.equal(leadJd.completedAt, clock);
  assert.equal(leadJd.completedBy, "ta");
  clock += 10;
  await (openings.approveJd as any)._handler(ctx, { actorId: "ta", openingId: "job1", jdMarkdown: "Revised and reviewed in one approval" });
  const revisedJd = (await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:"));
  assert.equal(revisedJd.completedAt, clock, "Editing and approving together records a new review time");
  assert.deepEqual(revisedJd.events.slice(-2).map((e: Row) => e.status), ["incomplete", "complete"]);
  await run("saveCheck", { actorId: "support", jobId: "job1", kind: "jd" });
  // A changed qualifying roster does not shift the time of a continuous completion.
  const profileAt = (await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("excel_profiles:")).completedAt;
  put("linkVault", { _id: "fourthProfile", openingId: "job1", addedBy: "ta", createdAt: clock, linkedinUrl: "https://linkedin.com/in/fourth", outcome: "contacted", conversationLog: [] });
  await db.patch("setup:ta:job1:0", { linkedinUrl: "" });
  await workdays.refreshWorkdayChecks(ctx, "job1" as any, "ta" as any);
  assert.equal((await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("excel_profiles:")).completedAt, profileAt);
  await db.patch("setup:ta:job1:0", { linkedinUrl: "https://linkedin.com/in/ta-job1-0" });
  await db.patch("research:job1", { fields: { country: "Sri Lanka" } });
  await workdays.refreshWorkdayChecks(ctx, "job1" as any, "ta" as any);
  checkedJob = (await run("dashboard", { actorId: "ta" })).active.jobs[0];
  assert.equal(checkedJob.checks.find((c: Row) => c.key.startsWith("research:")).status, "incomplete");
  assert.ok(checkedJob.checks.find((c: Row) => c.key.startsWith("research:")).events.some((e: Row) => e.status === "complete"));
  await run("saveCheck", { actorId: "ta", jobId: "job1", kind: "research" });
  await run("saveCheck", { actorId: "support", jobId: "job1", kind: "research" });
  await assert.rejects(() => workdays.recordActiveMode(ctx, "support" as any, "job3" as any, "Add-on"), /first workday/);
  await workdays.recordActiveMode(ctx, "support" as any, "job3" as any, "100%");
  assert.equal(rows("taWorkdays")[1].jobs[1].modeHistory.length, 1);

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
  assert.ok(hunted.checks.some((c: Row) => c.status === "complete" && c.key.startsWith("daily_email:")));
  assert.ok(hunted.checks.some((c: Row) => c.key.startsWith("director_wait:")));
  assert.equal(hunted.checks.some((c: Row) => c.key.startsWith("mail:") && c.status !== "complete"), false);

  // Linking a suitable prospect to an existing New CV is not a shortlist.
  put("applications", {
    _id: "linkedProspect",
    candidateId: "linkedCandidate",
    jobId: "job3",
    currentStage: "new_cvs",
    sourceChannel: "headhunting",
    createdAt: clock,
    lastStageChangedAt: clock,
    workdayReviewedAt: clock,
    isActive: true,
  });
  put("linkVault", {
    _id: "suitableLink",
    openingId: "job3",
    addedBy: "support",
    linkedinUrl: "https://example.invalid/profile",
    name: "Suitable prospect",
    outcome: "shortlisted",
    candidateId: "linkedCandidate",
    createdAt: clock,
    outcomeAt: clock,
    conversationLog: [],
  });
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  assert.ok(
    hunted.checks.some(
      (c: Row) => c.key === "profile:suitableLink" && !c.canCarry,
    ),
  );
  await db.patch("linkedProspect", {
    currentStage: "rejected",
    lastStageChangedAt: clock,
  });
  await db.patch("suitableLink", { outcomeAt: clock + 1 });
  hunted = (await run("dashboard", { actorId: "support" })).active.jobs.find(
    (j: Row) => j.jobId === "job3",
  );
  assert.ok(
    hunted.checks.some((c: Row) => c.label.includes("closed in the pipeline")),
  );

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
  await (openings.saveJd as any)._handler(ctx, { actorId: "ta", openingId: "job1", jdMarkdown: "Later JD after the finished day" });
  assert.deepEqual((await run("dashboard", { actorId: "ta", detail: true })).history[0].jobs, frozen.jobs, "Finished records keep the original JD review snapshot");
  // Current assignments must not disappear behind an older global job-list limit.
  for (let i = 0; i < 1005; i++)
    put("jobs", { _id: `older:${i}`, title: "Older job", assignedTaIds: [] });
  put("jobs", {
    _id: "newAssignedJob",
    title: "New assigned job",
    taLeadId: "lead",
    assignedTaIds: ["ta"],
  });
  put("jobAssignments", {
    _id: "newAssignment",
    jobId: "newAssignedJob",
    userId: "ta",
    assignmentRole: "primary_recruiter",
    isActive: true,
  });
  assert.ok(
    (await run("dashboard", { actorId: "ta", detail: true })).options.some(
      (job: Row) => job.id === "newAssignedJob",
    ),
  );
  user("ta2", "ta");
  for (const id of ["multi1", "multi2", "multi3"])
    put("jobs", {
      _id: id,
      title: id,
      taLeadId: "lead",
      assignedTaIds: ["ta2"],
    });
  await db.patch("multi1", { jobDescription: "Previously reviewed JD", jdStatus: "approved" });
  await recordJdReview(ctx, "ta2" as any, "multi1" as any, "Previously reviewed JD");
  const reusedJdAt = clock;
  clock += 10;
  const multiDay = await run("start", {
    actorId: "ta2",
    jobId: "multi1",
    workType: "100%",
  });
  const reusedJd = (await run("dashboard", { actorId: "ta2" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("jd_review:"));
  assert.equal(reusedJd.status, "complete", "A saved review before starting satisfies setup");
  assert.equal(reusedJd.completedAt, reusedJdAt);
  for (const jobId of ["multi2", "multi3"])
    assert.equal(
      (await run("addPosition", {
        actorId: "ta2",
        workdayId: multiDay.id,
        jobId,
        workType: "Add-on",
      })).pending,
      false,
      `${jobId} is direct without approval`,
    );
  assert.equal(
    rows("taWorkdays").find((d) => d._id === multiDay.id)?.jobs.length,
    3,
  );
  // Carryover includes every pending assigned job and does not use the ten manual slots.
  user("carryTa", "ta");
  const pastJobs = [];
  for (let i = 0; i < 12; i++) {
    const jobId = `carry:${i}`; pastJobs.push({ jobId, workType: "100%", addedAt: clock - 86400000, modeHistory: [] });
    put("jobs", { _id: jobId, title: jobId, status: "active", taLeadId: "lead", assignedTaIds: ["carryTa"] });
    put("applications", { _id: `carryApp:${i}`, jobId, ownerTaId: "carryTa", candidateId: `carryCandidate:${i}`, currentStage: "follow_up", lastStageChangedAt: clock - 86400000 });
  }
  put("taWorkdays", { _id: "pastCarryDay", userId: "carryTa", date: workdayDate(clock - 86400000), startedAt: clock - 86400000, finishedAt: clock - 1, jobs: pastJobs });
  put("jobs", { _id: "newPrimary", title: "New primary", status: "active", taLeadId: "lead", assignedTaIds: ["carryTa"] });
  const carryDay = await run("start", { actorId: "carryTa", jobId: "newPrimary", workType: "Follow-up" });
  const carried = await db.get(carryDay.id);
  assert.equal(carried?.jobs.length, 13);
  assert.equal(carried?.jobs[0].workType, "100%", "The browser cannot skip first-day setup by requesting Follow-up");
  assert.equal(carried?.jobs.filter((j: Row) => j.carried && j.workType === "Follow-up").length, 12);
  for (let i = 0; i < 9; i++) {
    const jobId = `manual:${i}`;
    put("jobs", { _id: jobId, title: jobId, taLeadId: "lead", assignedTaIds: ["carryTa"] });
    await run("addPosition", { actorId: "carryTa", workdayId: carryDay.id, jobId, workType: "100%" });
  }
  put("jobs", { _id: "manual:10", title: "One too many", taLeadId: "lead", assignedTaIds: ["carryTa"] });
  await assert.rejects(() => run("addPosition", { actorId: "carryTa", workdayId: carryDay.id, jobId: "manual:10", workType: "100%" }), /at most ten/);
  // A later Add-on session must not reuse this day's earlier email/explanation.
  user("addonTa", "ta");
  put("jobs", { _id: "addonJob", title: "Add-on job", status: "active", taLeadId: "lead", assignedTaIds: ["addonTa"] });
  put("taWorkdays", { _id: "addonPast", userId: "addonTa", date: workdayDate(clock - 86400000), startedAt: clock - 86400000, finishedAt: clock - 1, jobs: [{ jobId: "addonJob", workType: "100%", addedAt: clock - 86400000, modeHistory: [] }] });
  const addonDay = await run("start", { actorId: "addonTa", jobId: "addonJob", workType: "Follow-up" });
  await run("saveCheck", { actorId: "addonTa", jobId: "addonJob", kind: "noCandidates", reason: "Earlier session found no candidates" });
  await run("saveCheck", { actorId: "addonTa", jobId: "addonJob", kind: "chatgpt", link: "https://chatgpt.com/share/12345678", confirmed: true });
  put("taWorkdayMail", { _id: "earlierEmail", workdayId: addonDay.id, userId: "addonTa", jobId: "addonJob", applicationIds: [], status: "accepted", startedAt: clock, acceptedAt: clock, finalizedAt: clock });
  clock += 20;
  await run("setWorkType", { actorId: "addonTa", workdayId: addonDay.id, jobId: "addonJob", workType: "Add-on" });
  let addonChecks = (await run("dashboard", { actorId: "addonTa" })).active.jobs[0].checks;
  assert.equal(addonChecks.find((c: Row) => c.key.startsWith("director_candidate:")).status, "incomplete");
  assert.equal(addonChecks.find((c: Row) => c.key.startsWith("daily_email:")).status, "incomplete");
  assert.equal(addonChecks.some((c: Row) => c.key.startsWith("jd_review:")), false, "Add-on does not repeat JD setup");
  await run("saveCheck", { actorId: "addonTa", jobId: "addonJob", kind: "noCandidates", reason: "No additional suitable candidates in this Add-on session" });
  addonChecks = (await run("dashboard", { actorId: "addonTa" })).active.jobs[0].checks;
  assert.equal(addonChecks.find((c: Row) => c.key.startsWith("director_candidate:")).status, "complete");
  assert.equal(addonChecks.find((c: Row) => c.key.startsWith("daily_email:")).status, "incomplete");
  await assert.rejects(() => run("beginMail", { actorId: "addonTa", jobId: "addonJob", applicationIds: [], subject: "Synthetic Add-on update", sentTo: "director@example.invalid" }), /Job description reviewed; Research fields reviewed; Own Excel Tables profiles/, "All four send prerequisites apply to Add-on too");
  await db.patch("addonJob", { jobDescription: "Synthetic Add-on JD", jdStatus: "approved" });
  await run("saveCheck", { actorId: "addonTa", jobId: "addonJob", kind: "jd" });
  put("researchReports", { _id: "addonResearch", openingId: "addonJob", generatedAt: clock, fields: {} });
  await run("saveCheck", { actorId: "addonTa", jobId: "addonJob", kind: "research", reasons: Object.fromEntries(["similarDesignation", "websiteLink", "servicesProvider", "country", "location", "competitors", "socialMedia", "companyOverview"].map(k => [k, "Unavailable in synthetic fixture"])) });
  for (let i = 0; i < 3; i++) put("linkVault", { _id: `addonProfile:${i}`, openingId: "addonJob", addedBy: "addonTa", createdAt: clock, linkedinUrl: `https://linkedin.com/in/addon-${i}`, outcome: "contacted", conversationLog: [], isEyeMarked: false });
  const addonMail = await run("beginMail", { actorId: "addonTa", jobId: "addonJob", applicationIds: [], subject: "Synthetic Add-on update", sentTo: "director@example.invalid", researchLink: "https://chatgpt.com/share/12345678" });
  await run("mailResult", { id: addonMail.id, status: "accepted" });
  await run("finalizeMail", { actorId: "addonTa", id: addonMail.id });
  addonChecks = (await run("dashboard", { actorId: "addonTa" })).active.jobs[0].checks;
  assert.equal(addonChecks.find((c: Row) => c.key.startsWith("daily_email:")).status, "complete");
  console.log(
    "  ok  workday times, direct assigned positions, shared CV review, late arrivals, carry-forward expiry, email receipts, scoped lead history and idempotent completion",
  );
} finally {
  Date.now = realNow;
}
