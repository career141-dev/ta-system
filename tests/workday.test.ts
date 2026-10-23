import assert from "node:assert/strict";
import {
  applyCarryForwards,
  completionBlockers,
  emailBlockers,
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
    workType: "100%",
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
  // A lead sees work across teams, with management rights on their own jobs.
  const leaderView = await run("dashboard", { actorId: "lead", detail: true });
  const supportView = leaderView.team.find((d: Row) => d.userId === "support");
  assert.deepEqual(
    supportView.jobs.map((j: Row) => j.jobId),
    ["job1", "job3"],
  );
  assert.equal(supportView.jobs.find((job: Row) => job.jobId === "job3").canManage, false);
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
  put("taWorkdayTaskEvents", { _id: "retired:research", workdayId: day.id, jobId: "job1", userId: "ta", key: "research:job1", label: "Research fields reviewed", href: "/openings/job1/hh/research", kind: "details", status: "incomplete", at: clock });
  assert.ok(!(await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.some((c: Row) => c.key.startsWith("research:")), "Historical events cannot restore the retired research check");
  put("taWorkdayTaskEvents", { _id: "retired:exception", workdayId: day.id, jobId: "job1", userId: "ta", key: "director_candidate:job1", label: "Director Review candidate or explanation", href: "/openings/job1/eod", kind: "details", status: "complete", at: clock });
  assert.ok(!(await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.some((c: Row) => c.key.startsWith("director_candidate:")), "Old explanation history cannot replace the new required CV check");
  assert.ok((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).blockers.some((b: string) => b.includes("Suggestions")), "Suggestions review blocks email again");
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
    put("candidates", { _id: `requiredCandidate:${actorId}:${jobId}`, fullName: "Synthetic required CV", cvUploadId: "synthetic-cv" });
    put("applications", { _id: `requiredApp:${actorId}:${jobId}`, candidateId: `requiredCandidate:${actorId}:${jobId}`, jobId, ownerTaId: actorId, currentStage: "second_shortlist", sourceChannel: "Database", lastStageChangedAt: clock, cvFileId: "synthetic-cv", isAddOn: actorId === "ta" && jobId === "job2" });
  }
  // Human decisions are required for every result in the applicable round.
  clock++;
  for (const id of ["human:selected", "human:notSelected"]) put("profileSuggestions", { _id: id, openingId: "job1", generatedFor: "ta", round: 2, generatedAt: clock, status: "new" });
  await run("recordSourcingRun", { jobId: "job1", userId: "ta", round: 2, count: 2 });
  const suggestionsBlocked = async () => (await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).blockers.some((b: string) => b.includes("Suggestions"));
  assert.equal(await suggestionsBlocked(), true);
  await db.patch("human:selected", { status: "kept", keptBy: "ta" });
  assert.equal(await suggestionsBlocked(), true, "Selecting one result does not review the remaining result");
  await db.patch("human:notSelected", { status: "dismissed" });
  assert.equal(await suggestionsBlocked(), false, "Select/not-selected decisions complete human review");
  await db.patch("requiredApp:ta:job1", { cvFileId: undefined });
  await db.patch("requiredCandidate:ta:job1", { cvUploadId: undefined });
  assert.equal((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).ok, true, "100% preflight permits activity-only email without linked CVs");
  await db.patch("requiredApp:ta:job1", { cvFileId: "synthetic-cv" });
  await db.patch("requiredCandidate:ta:job1", { cvUploadId: "synthetic-cv" });
  // One eligible own profile is sufficient when all other send requirements pass.
  const originalProfiles = [...rows("linkVault")];
  tables.set("linkVault", originalProfiles.filter(l => l.openingId !== "job1" || l.addedBy !== "ta" || l._id === "setup:ta:job1:0"));
  put("linkVault", { _id: "count:duplicate", openingId: "job1", addedBy: "ta", createdAt: clock, linkedinUrl: "https://www.linkedin.com/in/ta-job1-0?tracking=1", outcome: "contacted", conversationLog: [] });
  put("linkVault", { _id: "count:invalid", openingId: "job1", addedBy: "ta", createdAt: clock, linkedinUrl: "https://example.invalid/person", outcome: "contacted", conversationLog: [] });
  put("linkVault", { _id: "count:lead", openingId: "job1", addedBy: "lead", createdAt: clock, linkedinUrl: "https://linkedin.com/in/lead-profile", outcome: "contacted", conversationLog: [] });
  let countedProfiles = (await run("dashboard", { actorId: "ta" })).active.jobs[0].checks.find((c: Row) => c.key.startsWith("excel_profiles:"));
  assert.equal(countedProfiles.progress, "1/1", "Only distinct recognised profiles added by the TA count; duplicates, non-profile links and lead-added rows are excluded");
  assert.equal(countedProfiles.status, "complete");
  assert.equal((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).ok, true, "One own profile is enough for the temporary EOD requirement");
  tables.set("linkVault", rows("linkVault").filter(l => l._id !== "setup:ta:job1:0" && l._id !== "count:duplicate"));
  assert.ok((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).blockers.some((b: string) => b.includes("Excel")), "Zero eligible own profiles still prevents sending");
  tables.set("linkVault", originalProfiles);
  const savedPosts = [...rows("jobPosts")];
  tables.set("jobPosts", savedPosts.filter(p => p.openingId !== "job1"));
  const savedNotes = rows("taWorkdayCheckNotes").find(n => n.userId === "ta" && n.jobId === "job1")!;
  const savedReason = savedNotes.noCandidateReason;
  await db.patch(savedNotes._id, { noCandidateReason: undefined });
  put("applications", { _id: "temporary:unreviewed", jobId: "job1", candidateId: "temporary:candidate", currentStage: "new_cvs", sourceChannel: "SCOOP", createdAt: clock, lastStageChangedAt: clock });
  assert.ok((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).blockers.some((b: string) => b.includes("LinkedIn")), "A LinkedIn link is compulsory even when other requirements pass");
  await assert.rejects(() => run("beginMail", { actorId: "ta", jobId: "job1", applicationIds: ["requiredApp:ta:job1"], subject: "Synthetic update", sentTo: "director@example.invalid" }), /LinkedIn/);
  await assert.rejects(() => run("beginMail", { actorId: "ta", jobId: "job1", applicationIds: [], subject: "Synthetic update", sentTo: "director@example.invalid" }), /LinkedIn/);
  tables.set("jobPosts", savedPosts);
  // Missing research fields and unrelated candidate work do not block an EOD
  // that contains a Director Review CV and has human-reviewed Suggestions.
  put("candidates", { _id: "temporary:readyCandidate", fullName: "Synthetic ready candidate" });
  put("applications", { _id: "temporary:followup", jobId: "job1", candidateId: "temporary:missingDetails", ownerTaId: "ta", currentStage: "follow_up", sourceChannel: "L", shortlistedAt: clock, lastStageChangedAt: clock });
  put("applications", { _id: "temporary:ready", jobId: "job1", candidateId: "temporary:readyCandidate", ownerTaId: "ta", currentStage: "second_shortlist", sourceChannel: "SCOOP", shortlistedAt: clock, lastStageChangedAt: clock });
  const reportedJob = (await run("dashboard", { actorId: "ta" })).active.jobs[0];
  assert.ok(reportedJob.checks.some((c: Row) => c.key.startsWith("candidate:") && c.status !== "complete"));
  assert.ok(!reportedJob.checks.some((c: Row) => c.key.startsWith("research:")));
  assert.ok(reportedJob.eodChecks.every((c: Row) => c.status === "complete"));
  assert.equal((await run("emailPreflight", { actorId: "ta", jobId: "job1", link: "https://chatgpt.com/share/12345678", confirmed: true })).ok, true, "Missing research fields do not block sending; the LinkedIn link, human decisions and Director Review CV do");
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
  await assert.rejects(() => run("finish", { actorId: "ta", workdayId: day.id }), /automatically/);
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
  assert.ok(!checkedJob.checks.some((c: Row) => c.key.startsWith("research:")), "Research edits never restore the retired field checklist");
  await run("saveCheck", { actorId: "ta", jobId: "job1", kind: "research" });
  await run("saveCheck", { actorId: "support", jobId: "job1", kind: "research" });
  await workdays.recordActiveMode(ctx, "support" as any, "job3" as any, "Add-on");
  assert.equal(rows("taWorkdays")[1].jobs[1].workType, "Add-on", "A newly entered historical job can be changed immediately");
  await workdays.recordActiveMode(ctx, "support" as any, "job3" as any, "100%");
  assert.equal(rows("taWorkdays")[1].jobs[1].modeHistory.length, 3, "Every manual mode change remains in the audit history");

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
  await assert.rejects(() => run("finish", { actorId: "ta", workdayId: day.id }), /automatically/);
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
    /assigned TA|active workday/,
  );
  await run("markReviewed", {
    actorId: "ta",
    workdayId: day.id,
    applicationId: "app",
  });
  assert.equal((await db.get("app"))?.workdayReviewedAt, clock);

  for (const jobId of ["job1", "job2"]) {
    if (jobId === "job2") {
      put("candidates", { _id: "notAddonCandidate", fullName: "Not an add-on", cvUploadId: "synthetic-cv" });
      put("applications", { _id: "notAddonApp", candidateId: "notAddonCandidate", jobId, ownerTaId: "ta", currentStage: "second_shortlist", sourceChannel: "Database", lastStageChangedAt: clock, cvFileId: "synthetic-cv", isAddOn: false });
      await assert.rejects(() => run("beginMail", {
        actorId: "ta", jobId, applicationIds: ["notAddonApp"], subject: "Synthetic Director Review CV", sentTo: "director@example.invalid",
      }), /Add-on candidates progressed to Director Review/);
    }
    const receipt = await run("beginMail", {
      actorId: "ta",
      jobId,
      applicationIds: [`requiredApp:ta:${jobId}`],
      subject: "Synthetic Director Review CV",
      sentTo: "director@example.invalid",
    });
    await assert.rejects(
      () =>
        run("beginMail", {
          actorId: "ta",
          jobId,
          applicationIds: [`requiredApp:ta:${jobId}`],
          subject: "Synthetic Director Review CV",
          sentTo: "director@example.invalid",
        }),
      /send in progress/,
    );
    await run("mailResult", { id: receipt.id, status: "accepted" });
    if (jobId === "job1") assert.equal((await db.get(day.id))?.finishedAt, undefined, "Acceptance alone does not finish before finalization");
    await run("finalizeMail", { actorId: "ta", id: receipt.id });
    await db.patch(`requiredApp:ta:${jobId}`, { currentStage: "director_shortlist" });
  }
  // Later arrivals do not reopen or stretch an EOD-completed workday.
  const eodFinishedAt = (await db.get(day.id))!.finishedAt;
  assert.equal(eodFinishedAt, clock);
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
  await assert.rejects(() => run("markReviewed", {
    actorId: "ta",
    workdayId: day.id,
    applicationId: "late",
  }), /active workday/);
  const finish = await run("finish", { actorId: "ta", workdayId: day.id });
  assert.equal(finish.ok, true);
  assert.equal(rows("taWorkdays")[0].finishedAt, eodFinishedAt);
  assert.deepEqual(
    await run("finish", { actorId: "ta", workdayId: day.id }),
    finish,
  );
  assert.deepEqual(await run("start", { actorId: "ta", jobId: "job1", workType: "100%" }), day, "Returning submissions reuse the same date without restarting the clock");
  await assert.rejects(
    () => run("finish", { actorId: "support", workdayId: day.id }),
    /not yours/,
  );
  await assertWorkdayScope(ctx, rows("users")[0] as any, "job2" as any);
  const frozen = (await run("dashboard", { actorId: "ta", detail: true }))
    .history[0];
  const finishedStatus = await run("dashboard", { actorId: "ta" });
  assert.equal(finishedStatus.lastFinishedAt, eodFinishedAt);
  assert.equal(finishedStatus.lastFinishedDate, workdayDate(clock));
  assert.equal(frozen.closureReason, "eod");
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
  for (const id of ["multi1", "multi2", "multi3"]) {
    put("jobs", {
      _id: id,
      title: id,
      taLeadId: "lead",
      assignedTaIds: ["ta2"],
    });
    put("jobAssignments", {
      _id: `assignment:${id}`,
      jobId: id,
      userId: "ta2",
      assignmentRole: "primary_recruiter",
      isActive: true,
    });
  }
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
  // New full hunts can be added while earlier positions still have required checks.
  for (const jobId of ["multi2", "multi3"]) {
    const before = (await run("dashboard", { actorId: "ta2" })).active;
    const entriesBefore = (await db.get(multiDay.id))!.jobs;
    assert.ok(completionBlockers(before.jobs).length > 0);
    assert.equal(
      (await run("addPosition", {
        actorId: "ta2",
        workdayId: multiDay.id,
        jobId,
        workType: "100%",
      })).pending,
      false,
      `${jobId} is direct without approval`,
    );
    const after = (await run("dashboard", { actorId: "ta2" })).active;
    assert.deepEqual(after.jobs.slice(0, before.jobs.length), before.jobs,
      "Adding a full hunt preserves earlier checklists and end-of-day checks");
    assert.deepEqual((await db.get(multiDay.id))!.jobs.slice(0, entriesBefore.length), entriesBefore,
      "Adding a full hunt preserves earlier work types and mode histories");
  }
  const fullHunts = (await db.get(multiDay.id))!.jobs;
  assert.deepEqual(fullHunts.map((j: Row) => j.jobId), ["multi1", "multi2", "multi3"]);
  for (const entry of fullHunts) {
    assert.equal(entry.workType, "100%");
    assert.deepEqual(entry.modeHistory, [{ at: entry.addedAt, workType: "100%" }]);
    assert.equal(rows("jobAssignments").find(a => a.jobId === entry.jobId && a.userId === "ta2")?.workingStage, "100%");
  }
  assert.equal(rows("taWorkdayRequests").filter(r => r.workdayId === multiDay.id).length, 0);
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
  assert.equal(carried?.jobs[0].workType, "Follow-up", "A historical job entered today can start directly in Follow-up");
  assert.equal(carried?.jobs.filter((j: Row) => j.carried && j.workType === "Follow-up").length, 12);
  for (let i = 0; i < 9; i++) {
    const jobId = `manual:${i}`;
    put("jobs", { _id: jobId, title: jobId, taLeadId: "lead", assignedTaIds: ["carryTa"] });
    await run("addPosition", { actorId: "carryTa", workdayId: carryDay.id, jobId, workType: "100%" });
  }
  put("jobs", { _id: "manual:10", title: "One too many", taLeadId: "lead", assignedTaIds: ["carryTa"] });
  await assert.rejects(() => run("addPosition", { actorId: "carryTa", workdayId: carryDay.id, jobId: "manual:10", workType: "100%" }), /at most ten/);
  // Returning positions track only EOD candidates, ChatGPT and the EOD email.
  const mixedDay = (await run("dashboard", { actorId: "carryTa" })).active;
  assert.ok(mixedDay.jobs.filter((j: Row) => j.workType === "100%").every((j: Row) => j.checks.length > 0));
  assert.ok(mixedDay.jobs.filter((j: Row) => j.workType === "Follow-up").every((j: Row) => j.checks.some((c: Row) => c.key.startsWith("chatgpt:"))));
  for (const mode of ["Follow-up", "Add-on"] as const) {
    const actorId = `returning:${mode}`;
    const jobId = `returningJob:${mode}`;
    user(actorId, "ta");
    put("jobs", { _id: jobId, title: jobId, status: "active", taLeadId: "lead", assignedTaIds: [actorId] });
    put("taWorkdays", { _id: `past:${mode}`, userId: actorId, date: workdayDate(clock - 86400000), startedAt: clock - 86400000, finishedAt: clock - 1, jobs: [{ jobId, workType: "100%", addedAt: clock - 86400000, modeHistory: [] }] });
    const returningDay = await run("start", { actorId, jobId, workType: mode });
    put("taWorkdayTaskEvents", { _id: `oldTask:${mode}`, workdayId: returningDay.id, userId: actorId, jobId, key: `chatgpt:${jobId}`, label: "Old research task", href: "/", kind: "details", status: "incomplete", at: clock });
    const current = (await run("dashboard", { actorId })).active.jobs[0];
    assert.deepEqual(current.checks.map((c: Row) => c.key.split(":")[0]), ["director_cv", "chatgpt", "daily_email"]);
    assert.deepEqual(current.eodChecks.map((c: Row) => c.key.split(":")[0]), ["director_cv", "chatgpt"]);
    const preflight = await run("emailPreflight", { actorId, jobId, link: "https://chatgpt.com/share/12345678", confirmed: true });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.workType, mode);
    const args = { actorId, jobId, applicationIds: [], subject: "Synthetic activity update", sentTo: "director@example.invalid" };
    const mail = await run("beginMail", args);
    assert.ok(mail.id);
    await assert.rejects(() => run("beginMail", args), /send in progress/);
    await run("mailResult", { id: mail.id, status: "accepted" });
    await run("finalizeMail", { actorId, id: mail.id });
    await assert.rejects(() => run("beginMail", args), /activity email has already been sent/);
    assert.equal((await run("finish", { actorId, workdayId: returningDay.id })).ok, true);
    const finished = (await run("dashboard", { actorId, detail: true })).history.find((d: Row) => d.id === returningDay.id);
    assert.ok(finished.jobs.every((j: Row) => j.checks.some((c: Row) => c.key.startsWith("daily_email:") && c.status === "complete")));
  }
  // Setup exceptions are scoped, audited and immediately usable, without sending mail.
  user("exceptionTa", "ta");
  user("exceptionOther", "ta");
  put("users", { _id: "exceptionAdmin", fullName: "Admin", email: "admin@example.invalid", role: "admin", isActive: true, isOnboarded: true });
  put("users", { _id: "inactiveAdmin", fullName: "Inactive", email: "inactive@example.invalid", role: "admin", isActive: false });
  put("jobs", { _id: "exceptionJob", title: "Exception job", status: "active", taLeadId: "lead", assignedTaIds: ["exceptionTa", "exceptionOther"] });
  const exceptionDay = await run("start", { actorId: "exceptionTa", jobId: "exceptionJob", workType: "100%" });
  const reasonArgs = { actorId: "exceptionTa", workdayId: exceptionDay.id, jobId: "exceptionJob", key: "jd_review:exceptionJob", reason: "Waiting for approved JD", withdraw: false };
  await assert.rejects(() => run("taskException", { ...reasonArgs, actorId: "exceptionOther" }), /not yours/);
  await assert.rejects(() => run("taskException", { ...reasonArgs, key: "director_cv:exceptionJob" }), /must be completed/);
  await assert.rejects(() => run("taskException", { ...reasonArgs, key: "daily_email:exceptionJob" }), /must be completed/);
  await assert.rejects(() => run("taskException", { ...reasonArgs, reason: "  " }), /Give a reason/);
  await assert.rejects(() => run("taskException", { ...reasonArgs, reason: "x".repeat(1001) }), /Give a reason/);
  await run("taskException", reasonArgs);
  const exceptionNotifications = () => rows("notifications").filter(n => n.type === "workday_exception" && n.workdayId === exceptionDay.id);
  assert.deepEqual(exceptionNotifications().map(n => n.userId).sort(), ["exceptionAdmin", "lead"]);
  await run("taskException", reasonArgs);
  assert.equal(exceptionNotifications().length, 2, "Retries do not create duplicate notifications");
  let exceptionJob = (await run("dashboard", { actorId: "exceptionTa" })).active.jobs[0];
  assert.equal(exceptionJob.checks.find((c: Row) => c.key === reasonArgs.key).status, "incomplete", "Excusing a task does not mark it complete");
  assert.ok(!emailBlockers([exceptionJob]).some(c => c.key === reasonArgs.key));
  assert.ok(!completionBlockers([exceptionJob]).some(c => c.key === reasonArgs.key));
  clock++;
  await run("taskException", { ...reasonArgs, reason: "JD approval delayed" });
  assert.equal(rows("taWorkdayExceptions").filter(e => e.workdayId === exceptionDay.id).length, 2, "Updates preserve the original reason");
  await run("taskException", { ...reasonArgs, withdraw: true });
  exceptionJob = (await run("dashboard", { actorId: "exceptionTa" })).active.jobs[0];
  assert.ok(emailBlockers([exceptionJob]).some(c => c.key === reasonArgs.key));
  assert.equal(exceptionJob.checks.find((c: Row) => c.key === reasonArgs.key).events.filter((e: Row) => e.status.startsWith("reason_")).length, 3);
  await run("taskException", reasonArgs);
  await db.patch("exceptionJob", { jobDescription: "A newly supplied JD" });
  exceptionJob = (await run("dashboard", { actorId: "exceptionTa" })).active.jobs[0];
  assert.ok(emailBlockers([exceptionJob]).some(c => c.key === reasonArgs.key), "Changed evidence reopens the task");
  for (const prefix of ["jd_review", "linkedin_post", "suggestions", "excel_profiles", "chatgpt"]) {
    await run("taskException", { ...reasonArgs, key: `${prefix}:exceptionJob`, reason: `${prefix} unavailable today` });
  }
  assert.equal(await run("researchExceptionAllowed", { actorId: "exceptionTa", jobId: "exceptionJob" }), true);
  assert.equal((await run("emailPreflight", { actorId: "exceptionTa", jobId: "exceptionJob", link: "", confirmed: false })).ok, true, "100% activity email requires no CV when other checks pass");
  const activityMail = await run("beginMail", { actorId: "exceptionTa", jobId: "exceptionJob", applicationIds: [], subject: "Synthetic", sentTo: "director@example.invalid" });
  assert.ok(activityMail.id, "100% activity-only mail can be reserved without CVs");
  await run("mailResult", { id: activityMail.id, status: "failed", error: "Synthetic failure" });
  put("candidates", { _id: "exceptionCandidate", fullName: "Synthetic", cvUploadId: "synthetic-cv" });
  put("applications", { _id: "exceptionApp", jobId: "exceptionJob", ownerTaId: "exceptionTa", workdayReviewedAt: clock, candidateId: "exceptionCandidate", currentStage: "second_shortlist", cvFileId: "synthetic-cv", lastStageChangedAt: clock });
  assert.equal((await run("emailPreflight", { actorId: "exceptionTa", jobId: "exceptionJob", link: "", confirmed: false })).ok, true);
  await assert.rejects(() => run("emailPreflight", { actorId: "exceptionTa", jobId: "exceptionJob", link: "https://chatgpt.com/c/private", confirmed: false }), /private/);
  const exceptionMail = await run("beginMail", { actorId: "exceptionTa", jobId: "exceptionJob", applicationIds: ["exceptionApp"], subject: "Synthetic exception email", sentTo: "director@example.invalid" });
  assert.ok(exceptionMail.id, "The transactional send reservation accepts valid exceptions");
  await run("mailResult", { id: exceptionMail.id, status: "accepted" });
  await run("finalizeMail", { actorId: "exceptionTa", id: exceptionMail.id });
  assert.equal((await db.get(exceptionDay.id))?.finishedAt, clock, "An accepted EOD completes without carrying candidate actions");
  assert.equal((await run("finish", { actorId: "exceptionTa", workdayId: exceptionDay.id })).ok, true);
  const finishedException = await db.get(exceptionDay.id);
  assert.ok(finishedException?.completion.jobs[0].checks.find((c: Row) => c.key === reasonArgs.key).exception, "Finished snapshots preserve reasons");
  await assert.rejects(() => run("taskException", reasonArgs), /finished/);
  const focused = await run("dashboard", { actorId: "lead", detail: true, focusWorkday: exceptionDay.id });
  assert.equal(focused.team[0].id, exceptionDay.id);
  // Directors use the same panel as reviewers, without gaining lead/TA writes.
  put("users", { _id: "directorSeat", fullName: "Director", email: "director@example.invalid", role: "director", isActive: true, isOnboarded: true });
  const directorView = await run("dashboard", { actorId: "directorSeat", detail: true, focusWorkday: exceptionDay.id });
  assert.equal(directorView.canReview, true);
  assert.equal(directorView.canLead, false);
  assert.equal(directorView.canWork, false);
  assert.equal(directorView.team[0].id, exceptionDay.id);
  assert.ok(directorView.team[0].jobs[0].checks.some((c: Row) => c.exception), "Director sees recorded reasons in the same workday view");
  await assert.rejects(() => run("start", { actorId: "directorSeat", jobId: "exceptionJob", workType: "100%" }), /Workdays are for TAs/);
  await assert.rejects(() => run("markReviewed", { actorId: "directorSeat", workdayId: exceptionDay.id, applicationId: "exceptionApp" }), /Workdays are for TAs/);
  await assert.rejects(() => run("taskException", { ...reasonArgs, actorId: "directorSeat" }), /Workdays are for TAs/);
  const supportCapabilities = await run("dashboard", { actorId: "support" });
  assert.equal(supportCapabilities.canWork, true);
  assert.equal(supportCapabilities.canReview, false);
  const adminView = await run("dashboard", { actorId: "exceptionAdmin", detail: true, focusWorkday: exceptionDay.id });
  assert.equal(adminView.canReview, true);
  assert.equal(adminView.canLead, true);
  assert.equal(adminView.team[0].id, exceptionDay.id);
  user("viewerSeat", "viewer");
  await assert.rejects(() => run("dashboard", { actorId: "viewerSeat", detail: true }), /cannot access/);
  const unauthorizedFocus = await run("dashboard", { actorId: "otherLead", detail: true, focusWorkday: exceptionDay.id });
  assert.equal(unauthorizedFocus.team[0].id, exceptionDay.id, "TA leads can inspect another lead's workday");
  assert.equal(unauthorizedFocus.team[0].jobs[0].canManage, false, "Cross-team viewing does not grant review actions");
  assert.equal(focused.team[0].jobs[0].canManage, true, "The assigned lead keeps review actions");
  // Assignment selectors remain available before a TA records any work.
  user("notStartedTa", "ta");
  put("jobs", { _id: "notStartedJob", title: "Not started position", taLeadId: "lead", assignedTaIds: ["notStartedTa"] });
  user("unassignedTa", "ta");
  const selectorView = await run("dashboard", { actorId: "lead", detail: true, date: workdayDate(clock), taId: "notStartedTa" });
  assert.ok(selectorView.teamAssignments.some((a: Row) => a.userId === "notStartedTa" && a.jobId === "notStartedJob"));
  assert.ok(selectorView.teamMembers.some((member: Row) => member.userId === "unassignedTa"), "All active TAs appear even without assigned positions");
  assert.equal(selectorView.team.length, 0, "An assignment must not invent workday activity");
  const otherSelectorView = await run("dashboard", { actorId: "otherLead", detail: true, date: workdayDate(clock), taId: "notStartedTa" });
  assert.ok(otherSelectorView.teamAssignments.some((a: Row) => a.jobId === "notStartedJob"), "TA leads see positions across teams");
  assert.equal(otherSelectorView.team.length, 0, "A TA with no recorded work has no activity");
  const datedView = await run("dashboard", { actorId: "lead", detail: true, date: finishedException!.date, taId: "exceptionTa" });
  assert.ok(datedView.team.some((day: Row) => day.id === exceptionDay.id), "Selected TA activity is fetched for the chosen date");
  // The same job on a later workday must not inherit any exception.
  clock += 86400000;
  await run("start", { actorId: "exceptionTa", jobId: "exceptionJob", workType: "100%" });
  exceptionJob = (await run("dashboard", { actorId: "exceptionTa" })).active.jobs[0];
  assert.equal(exceptionJob.eodChecks.some((c: Row) => c.exception), false);

  // A returning-only day closes on the final EOD and stays usable afterward.
  user("autoTa", "ta");
  for (const id of ["autoA", "autoB", "autoC"]) put("jobs", { _id: id, title: id, taLeadId: "lead", assignedTaIds: ["autoTa"] });
  const autoDay = await run("start", { actorId: "autoTa", jobId: "autoA", workType: "Follow-up" });
  await run("addPosition", { actorId: "autoTa", workdayId: autoDay.id, jobId: "autoB", workType: "100%" });
  await run("setWorkType", { actorId: "autoTa", workdayId: autoDay.id, jobId: "autoB", workType: "Add-on" });
  assert.equal((await db.get(autoDay.id))!.jobs[1].modeHistory.length, 2, "Accidental 100% selection can be corrected in the work list");
  const submitActivity = async (jobId: string) => {
    await run("emailPreflight", { actorId: "autoTa", jobId, link: "https://chatgpt.com/share/12345678", confirmed: true });
    const mail = await run("beginMail", { actorId: "autoTa", jobId, applicationIds: [], subject: "Synthetic activity", sentTo: "director@example.invalid" });
    await run("mailResult", { id: mail.id, status: "accepted" });
    await run("finalizeMail", { actorId: "autoTa", id: mail.id });
  };
  await submitActivity("autoA");
  assert.equal((await db.get(autoDay.id))?.finishedAt, undefined);
  clock += 1000;
  await submitActivity("autoB");
  const stoppedAt = clock;
  assert.equal((await db.get(autoDay.id))?.finishedAt, stoppedAt);
  await run("addPosition", { actorId: "autoTa", workdayId: autoDay.id, jobId: "autoC", workType: "Follow-up" });
  await run("setWorkType", { actorId: "autoTa", workdayId: autoDay.id, jobId: "autoC", workType: "Add-on" });
  clock += 1000;
  await submitActivity("autoC");
  assert.equal((await db.get(autoDay.id))?.finishedAt, stoppedAt, "Later returning emails do not restart the clock");
  const liveDay = (await run("dashboard", { actorId: "autoTa" })).active;
  assert.equal(liveDay.jobs.filter((j: Row) => !j.eodSentAt).length, 0);

  // An opening in the Bin stops being current work without rewriting the
  // workday. Restore can therefore put it back, while completed history stays
  // an exact record of what the TA worked before deletion.
  user("deletedTa", "ta");
  put("jobs", { _id: "deletedJob", title: "Deleted job", status: "active", taLeadId: "lead", assignedTaIds: ["deletedTa"] });
  put("jobs", { _id: "keptJob", title: "Kept job", status: "active", taLeadId: "lead", assignedTaIds: ["deletedTa"] });
  const deletedDay = await run("start", { actorId: "deletedTa", jobId: "deletedJob", workType: "100%" });
  await run("addPosition", { actorId: "deletedTa", workdayId: deletedDay.id, jobId: "keptJob", workType: "Follow-up" });
  await db.patch("deletedJob", { binnedAt: clock, status: "cancelled" });
  let deletedView = (await run("dashboard", { actorId: "deletedTa", detail: true })).active;
  assert.deepEqual(deletedView.jobs.map((job: Row) => job.jobId), ["keptJob"], "A binned opening leaves the active workday");
  const deletedLeadView = await run("dashboard", { actorId: "lead", detail: true, focusWorkday: deletedDay.id });
  assert.deepEqual(deletedLeadView.team[0].jobs.map((job: Row) => job.jobId), ["keptJob"], "The lead no longer sees the binned opening as current work");
  put("taWorkdayMail", { _id: "keptReceipt", workdayId: deletedDay.id, jobId: "keptJob", userId: "deletedTa", workType: "Follow-up",
    status: "accepted", startedAt: clock, acceptedAt: clock, finalizedAt: clock, applicationIds: [] });
  await workdays.autoCompleteWorkday(ctx, deletedDay.id);
  assert.equal((await db.get(deletedDay.id))?.finishedAt, clock, "A binned opening cannot block completion of the remaining work");
  const deletedHistory = (await run("dashboard", { actorId: "deletedTa", detail: true })).history.find((day: Row) => day.id === deletedDay.id);
  assert.deepEqual(deletedHistory.jobs.map((job: Row) => job.jobId), ["deletedJob", "keptJob"], "Completed history keeps the original positions");

  user("restoreTa", "ta");
  put("jobs", { _id: "restoreJob", title: "Restore job", status: "active", taLeadId: "lead", assignedTaIds: ["restoreTa"] });
  const restoreDay = await run("start", { actorId: "restoreTa", jobId: "restoreJob", workType: "100%" });
  put("taWorkdayRequests", { _id: "restoreRequest", workdayId: restoreDay.id, userId: "restoreTa", jobId: "restoreJob", leadId: "lead", workType: "100%", status: "pending", requestedAt: clock });
  await db.patch("restoreJob", { binnedAt: clock, status: "cancelled" });
  deletedView = (await run("dashboard", { actorId: "restoreTa", detail: true })).active;
  assert.deepEqual([deletedView.jobs.length, deletedView.requests.length], [0, 0], "A workday with only a deleted opening remains active but empty");
  assert.equal((await run("dashboard", { actorId: "lead", detail: true, focusWorkday: restoreDay.id })).team.length, 0, "The lead does not see an empty deleted-opening workday");
  await db.patch("restoreJob", { binnedAt: undefined, status: "active" });
  deletedView = (await run("dashboard", { actorId: "restoreTa", detail: true })).active;
  assert.deepEqual([deletedView.jobs[0].jobId, deletedView.requests[0].id], ["restoreJob", "restoreRequest"], "Restoring the opening restores its current workday state");

  user("missingTa", "ta");
  put("taWorkdays", { _id: "missingDay", userId: "missingTa", date: workdayDate(clock), startedAt: clock,
    jobs: [{ jobId: "missingJob", workType: "100%", addedAt: clock, leadId: "lead", modeHistory: [] }] });
  assert.equal((await run("dashboard", { actorId: "missingTa" })).active.jobs.length, 0, "A permanently missing opening is not shown as Unavailable job");

  // Yesterday's unfinished records never masquerade as today's workday.
  user("staleTa", "ta");
  put("jobs", { _id: "staleJob", title: "Stale", taLeadId: "lead", assignedTaIds: ["staleTa"] });
  put("taWorkdays", { _id: "staleDay", userId: "staleTa", date: workdayDate(clock - 86400000), startedAt: clock - 86400000,
    jobs: [{ jobId: "staleJob", workType: "100%", addedAt: clock - 86400000, modeHistory: [] }] });
  assert.equal((await run("dashboard", { actorId: "staleTa" })).active, null);
  assert.equal((await run("recoverOpenWorkdays", { dryRun: true })).affected > 0, true);
  assert.equal((await db.get("staleDay"))?.finishedAt, undefined, "Dry run does not mutate records");
  const newDay = await run("start", { actorId: "staleTa", jobId: "staleJob", workType: "Follow-up" });
  assert.notEqual(newDay.id, "staleDay");
  assert.equal((await db.get("staleDay"))?.closureReason, "expired");
  assert.equal((await db.get(newDay.id))?.date, workdayDate(clock));
  user("recoverTa", "ta");
  put("jobs", { _id: "recoverJob", title: "Recover", taLeadId: "lead", assignedTaIds: ["recoverTa"] });
  const acceptedYesterday = clock - 86400000;
  put("taWorkdays", { _id: "recoverDay", userId: "recoverTa", date: workdayDate(acceptedYesterday), startedAt: acceptedYesterday - 3600000,
    jobs: [{ jobId: "recoverJob", workType: "100%", addedAt: acceptedYesterday - 3600000, modeHistory: [] }] });
  put("taWorkdayMail", { _id: "recoverReceipt", workdayId: "recoverDay", jobId: "recoverJob", userId: "recoverTa", workType: "100%",
    status: "accepted", startedAt: acceptedYesterday - 1000, acceptedAt: acceptedYesterday, finalizedAt: acceptedYesterday, applicationIds: [] });
  await run("start", { actorId: "recoverTa", jobId: "recoverJob", workType: "Follow-up" });
  assert.equal((await db.get("recoverDay"))?.finishedAt, acceptedYesterday, "Yesterday's accepted EOD recovers its original finish time");
  assert.equal((await db.get("recoverDay"))?.closureReason, "eod");
  console.log(
    "  ok  workday times, direct assigned positions, shared CV review, late arrivals, carry-forward expiry, email receipts, scoped lead history and idempotent completion",
  );
} finally {
  Date.now = realNow;
}
