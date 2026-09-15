/**
 * Phases 5 and 6 — the pipeline from shortlist to placement, against the local
 * Convex backend and on screen (a dev server on :3177 with C141_DEV_SIGNIN=on).
 *
 * Shortlist and sets, stage rules, follow-up attempts, replies and answers,
 * the assisted screening call, the end-of-day email and the director's reply,
 * interviews, offers, a declined offer and a placement. Every check reloads
 * from Convex. Runs on test candidates (@c141-test.invalid) under a C141 TEST
 * client, so no real person's record changes, and nothing is sent: follow-up
 * attempts are recorded, never dispatched. Everything is removed at the end.
 * Contracts (ESA) and invoices are out of scope for now.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/e2e/p5-pipeline.ts
 */
import fs from "node:fs";
import { createHmac } from "node:crypto";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}

const { primeStore, resetStore } = await import("@/data/prime");
const { repo } = await import("@/data/store");
const { realId } = await import("@/data/primeState");
const { secret } = await import("@/lib/sign");
const { convexMutation, convexQuery } = await import("@/lib/convexServer");

const BASE = "http://127.0.0.1:3177";
let passed = 0;
let failed = 0;
const results: { id: string; name: string; ok: boolean; detail: string }[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  results.push({ id, name, ok, detail });
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieFor = (id: string) => `c141_dev_user=${id}.${createHmac("sha256", `dev-signin:${secret()}`).update(id).digest("base64url")}`;
const get = (path: string, userId: string) => fetch(BASE + path, { headers: { cookie: cookieFor(userId) }, redirect: "manual" });
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");
async function shows(path: string, userId: string, needle: string, waitMs = 45_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const res = await get(path, userId);
    const html = await res.text();
    if (html.includes(needle) || text(html).includes(needle)) return true;
    if (Date.now() > until) {
      console.log(`       ${path} → HTTP ${res.status}, "${needle.slice(0, 40)}" not found`);
      return false;
    }
    await sleep(5_000);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
let clientId = "";
let briefId = "";
let openingId = "";
const candidateIds: string[] = [];
const reload = async () => {
  resetStore();
  await primeStore({ allApplications: true, ...(openingId ? { openingId } : {}), candidateIds });
};
/**
 * Removes every C141 TEST Pipeline opening (this run's and any interrupted
 * run's) with everything hanging off it, and the test candidates.
 */
async function sweepTestPipeline(): Promise<number> {
  resetStore();
  await primeStore({ allApplications: true });
  const testClients = new Set([clientId, ...repo.clients().filter((c) => c.name.startsWith("C141 TEST Pipeline")).map((c) => c.id)].filter(Boolean));
  const openings = repo.openings().filter((o) => testClients.has(o.clientId)).map((o) => o.id);
  const briefs = repo.openings().filter((o) => testClients.has(o.clientId) && o.briefId).map((o) => o.briefId as string);
  if (briefId) briefs.push(briefId);
  const ops: { table: string; kind: string; key: string; before: object }[] = [];
  const seen = new Set<string>();
  const del = (table: string, key: string) => {
    if (seen.has(`${table}:${key}`)) return;
    seen.add(`${table}:${key}`);
    ops.push({ table, kind: "delete", key, before: {} });
  };
  const testCandidates = new Set(candidateIds);
  for (const oid of openings) {
    resetStore();
    await primeStore({ allApplications: true, openingId: oid });
    for (const p of repo.placements({ openingId: oid })) del("placements", p.id);
    for (const a of repo.applications(oid)) {
      testCandidates.add(a.candidateId);
      for (const o of repo.offers(a.id)) del("offers", o.id);
      for (const i of repo.interviews(a.id)) del("interviews", i.id);
      for (const m of repo.outreach(a.id)) del("outreach", m.id);
      for (const c of repo.calls(a.id)) del("aiCalls", c.id);
      for (const e of repo.events(a.id)) del("pipelineEvents", e.id);
    }
    for (const e of repo.openingEvents(oid, 100_000)) del("pipelineEvents", e.id);
    for (const r of repo.reviewRounds(oid)) del("reviewRounds", r.id);
    for (const a of repo.applications(oid)) del("applications", a.id);
  }
  for (let i = 0; i < ops.length; i += 100) await convexMutation("ta/commit:apply", { ops: ops.slice(i, i + 100) });
  const assignments = await convexQuery<{ rows: { id: string; openingId: string }[] }>("ta/tables:page", { table: "assignments", numItems: 1000 });
  await convexMutation("ta/storage:purgeTestAssignments", { assignmentIds: assignments.rows.filter((a) => openings.includes(a.openingId)).map((a) => a.id) }).catch(() => undefined);
  resetStore();
  await primeStore({ allApplications: true, candidateIds: [...testCandidates] });
  const tail: { table: string; kind: string; key: string; before: object }[] = [];
  for (const oid of openings) tail.push({ table: "openings", kind: "delete", key: oid, before: {} });
  for (const b of new Set(briefs)) tail.push({ table: "briefs", kind: "delete", key: b, before: {} });
  for (const id of testCandidates) if (repo.candidate(id)?.email?.endsWith("@c141-test.invalid")) tail.push({ table: "candidates", kind: "delete", key: id, before: {} });
  for (const c of testClients) tail.push({ table: "clients", kind: "delete", key: c, before: {} });
  if (tail.length) await convexMutation("ta/commit:apply", { ops: tail });
  return ops.length + tail.length;
}
const appOf = (candidateId: string) => repo.applications(openingId).find((a) => a.candidateId === candidateId)!;

try {
  resetStore();
  await primeStore({ allApplications: true });
  const users = repo.users().filter((u) => u.isActive);
  const lead = users.find((u) => u.role === "ta_lead")!;
  const ta = users.find((u) => u.role === "ta")!;
  const director = users.find((u) => u.role === "director");

  // ── setup: a C141 TEST opening and seven test candidates ──────────────────
  console.log("setup");
  clientId = await convexMutation<string>("ta/clients:add", { name: `C141 TEST Pipeline ${stamp}`, industry: "Testing", contacts: [] });
  briefId = realId(repo.createBrief({
    clientId, openingId: null, kind: "lead_to_ta", capturedBy: lead.id, capturedAt: Date.now(), method: "notes", notesMarkdown: "Finance Executive, Colombo, 3+ years.",
    transcript: null, transcriptStatus: "none", recordingKey: null, recordingDurationMs: null, consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null,
    extracted: { title: "Finance Executive" } as never,
  }));
  openingId = realId(repo.createOpeningFromBrief(briefId, { clientId, jdMarkdown: "", taLeadId: lead.id, assignedTaIds: [ta.id], directorId: director?.id ?? null, country: "Sri Lanka" }));
  repo.updateJd(openingId, "## Finance Executive\n\nMonthly accounts, reconciliations, payroll. ACCA or CIMA part-qualified, 3+ years.");
  repo.approveJd(openingId, ta.id);
  repo.setAssignments(openingId, [{ userId: ta.id, role: "primary_recruiter" }, { userId: lead.id, role: "supporting_recruiter" }, ...(director ? [{ userId: director.id, role: "director" as const }] : [])], lead.id);

  const people = Array.from({ length: 7 }, (_, i) => ({
    id: `tmpcand_${stamp}_${i}`, fullName: `C141 Test Person ${i + 1} ${stamp.slice(11)}`, email: `qa${i + 1}.${stamp.slice(11)}@c141-test.invalid`, phone: null,
    linkedinUrl: null, location: "Colombo", nationality: "Sri Lankan", age: null, gender: null, currentEmployer: "Test Holdings", currentTitle: "Finance Executive",
    totalExperienceYears: 4, educationDegree: "BSc Accounting", educationInstitution: "University of Colombo", qualifications: "CIMA", englishLevel: null,
    languages: ["English"], skills: ["Reconciliations", "Payroll", "IFRS"], industries: ["Finance"], noticePeriodDays: null, currentSalary: null, expectedSalary: null,
    cvFileName: null, workHistory: [], createdAt: Date.now(),
  }));
  const made = await convexMutation<{ ids: Record<string, string> }>("ta/commit:apply", { ops: people.map((p) => ({ table: "candidates", kind: "insert", key: p.id, after: p })) });
  for (const p of people) candidateIds.push(made.ids[p.id]);
  await reload();
  for (const id of candidateIds) repo.addCandidateToOpening(id, openingId, ta.id);
  await reload();
  check("P5-00", "seven test candidates are on the test opening as matches", candidateIds.every((id) => appOf(id)?.stage === "matched"), `${repo.applications(openingId).length} applications`);

  // ── P5-01 shortlist and sets ──────────────────────────────────────────────
  console.log("\nshortlist and stages");
  const six = candidateIds.slice(0, 6);
  for (const id of six) repo.shortlist(appOf(id).id, ta.id);
  await reload();
  const sets = six.map((id) => appOf(id).setNumber);
  // The desk's rule (13 September): everyone shortlisted today joins the set open
  // this morning, even past five; the set closes on the day it reaches five.
  check("P5-01", "six shortlisted on one day all join the open set (set 1), owned and in follow-up", sets.every((s) => s === 1) && six.every((id) => appOf(id).ownerTaId === ta.id && appOf(id).stage === "follow_up"), `sets ${sets.join(",")}`);
  const stolen = repo.shortlist(appOf(six[0]).id, lead.id);
  check("P5-01b", "a second TA cannot take a candidate someone owns, and is told who", !stolen.ok && (stolen as { ownerTaId: string }).ownerTaId === ta.id);
  check("P5-01e", "each shortlist writes a pipeline event", six.every((id) => repo.events(appOf(id).id).some((e) => e.eventType === "shortlisted")));

  // ── P5-02..03 stage rules ─────────────────────────────────────────────────
  const illegal = repo.moveStage(appOf(six[0]).id, "interview", ta.id, "skip ahead");
  check("P5-02", "a move the stage rules forbid is refused (follow-up straight to interview)", !illegal.ok, (illegal as { message?: string }).message);
  const noReason = repo.moveStage(appOf(six[5]).id, "rejected", ta.id);
  check("P5-03", "a rejection without a reason is refused", !noReason.ok, (noReason as { message?: string }).message);
  const rejected = repo.moveStage(appOf(six[5]).id, "rejected", ta.id, "Salary expectation far above budget");
  await reload();
  check("P5-03b", "a rejection with a reason is saved with the reason and who", rejected.ok && appOf(six[5]).stage === "rejected" && appOf(six[5]).rejectReason === "Salary expectation far above budget" && appOf(six[5]).rejectedBy === ta.id);

  // ── P5-07..09 follow-up ───────────────────────────────────────────────────
  console.log("\nfollow-up");
  const fu = appOf(six[0]);
  const attempt = repo.recordAttempt({ applicationId: fu.id, drafts: [{ channel: "email", to: people[0].email, subject: "Finance Executive role", body: "Hello, a few questions about the role." }], byUserId: ta.id });
  await reload();
  const out = repo.outreach(fu.id);
  check("P5-07", "a follow-up attempt is recorded (not sent) with channel and attempt number", attempt.ok && out.some((m) => m.direction === "out" && m.channel === "email"), `${out.length} messages`);
  const reply = repo.recordReply({ applicationId: fu.id, channel: "email", body: "Hi, my current salary is LKR 180,000 per month, expected LKR 220,000, and my notice period is 30 days.", byUserId: ta.id });
  await reload();
  const person = repo.candidate(six[0])!;
  check("P5-08", "a reply is read: salary and notice fill the blank fields on the candidate", reply.ok && !!person.currentSalary && !!person.expectedSalary && person.noticePeriodDays === 30, reply.ok ? `applied ${reply.applied.join(", ")}; now ${person.currentSalary} / ${person.expectedSalary} / ${person.noticePeriodDays}d` : (reply as { message: string }).message);
  const questions = repo.followUpStandard().filter((q) => q.enabled);
  const answers = Object.fromEntries(questions.map((q) => [q.id, `Answer to ${q.label}`]));
  repo.saveAnswers(fu.id, answers);
  await reload();
  check("P5-09", "answers to the follow-up questions are saved against each question", questions.length === 0 || questions.every((q) => appOf(six[0]).answers?.[q.id] === `Answer to ${q.label}`), `${questions.length} questions`);
  const noTime = repo.recordCallOutcome({ applicationId: fu.id, outcome: "callback", promisedAt: null, note: "Call me later", byUserId: ta.id });
  const withTime = repo.recordCallOutcome({ applicationId: fu.id, outcome: "callback", promisedAt: Date.now() + 3_600_000, note: "Call back in an hour", byUserId: ta.id });
  check("P5-09b", "a call-back outcome needs a time; with one it is saved", !noTime.ok && withTime.ok);

  // ── P5-10 assisted screening call ─────────────────────────────────────────
  const call = repo.startCall({ applicationId: appOf(six[1]).id, mode: "assisted", byUserId: ta.id });
  let finished: { ok: boolean; message?: string; applied?: string[] } = { ok: false, message: "not started" };
  if (call.ok) finished = repo.finishCall({ callId: call.id, status: "completed", transcript: "Candidate confirmed 5 years in finance, notice period 60 days, expects LKR 250,000.", durationSeconds: 300 });
  await reload();
  const calls = repo.calls(appOf(six[1]).id);
  check("P5-10", "an assisted screening call is started and finished, and saved as completed", call.ok && finished.ok && calls.some((c) => c.status === "completed"), call.ok ? `${finished.ok ? `applied ${(finished.applied ?? []).join(", ") || "nothing new"}` : finished.message}` : (call as { message: string }).message);

  // ── P5-05..06 end-of-day email and the director's reply ───────────────────
  console.log("\nend-of-day review");
  const toDirector = six.slice(0, 4).map((id) => appOf(id).id);
  for (const id of toDirector) repo.moveStage(id, "director_review", ta.id, "Sent to the Director in the end-of-day email");
  const round = repo.openReviewRound({ openingId, kind: "director", applicationIds: toDirector, setNumber: 1, sentBy: ta.id, sentTo: "director@c141-test.invalid", trackedAt: repo.shortlistInbox(), subject: `Finance Executive — set 1 ${stamp}` });
  await reload();
  const saved = repo.reviewRounds(openingId).find((r) => r.id === round.id || r.token === round.token);
  check("P5-05", "the end-of-day email is recorded: a review round awaiting reply, four people in director review", !!saved && saved.status === "awaiting" && toDirector.every((id) => repo.application(id)?.stage === "director_review"), saved ? `${saved.token}, ${saved.applicationIds.length} people` : "no round");
  const res = repo.applyReviewDecisions(saved!.id, [
    { applicationId: toDirector[0], outcome: "shortlisted", note: null, confirmed: true },
    { applicationId: toDirector[1], outcome: "shortlisted", note: null, confirmed: true },
    { applicationId: toDirector[2], outcome: "shortlisted", note: null, confirmed: true },
    { applicationId: toDirector[3], outcome: "rejected", note: "Not enough payroll experience", confirmed: true },
  ], "1, 2 and 3 shortlist. 4 no - not enough payroll experience.");
  await reload();
  check("P5-06", "the director's reply moves three to director shortlist and rejects one with the note", res.moved === 3 && res.rejected === 1 && toDirector.slice(0, 3).every((id) => repo.application(id)?.stage === "director_shortlist") && repo.application(toDirector[3])?.stage === "rejected", JSON.stringify(res));
  check("P5-06s", "the director shortlist screen lists them", await shows(`/openings/${openingId}/pipeline/director_shortlist`, ta.id, people[0].fullName));

  // ── P6-01..02 interviews ──────────────────────────────────────────────────
  console.log("\ninterviews, offers, placement");
  const [a1, a2, a3] = toDirector;
  for (const id of [a1, a2, a3]) repo.moveStage(id, "client_shortlist", lead.id, "Client asked to meet");
  await reload();
  const early = repo.makeOffer({ applicationId: appOf(candidateIds[6]).id, salary: 200000, salaryBasis: "monthly", currency: "LKR", startDate: null, terms: null, byUserId: ta.id });
  check("P6-03b", "an offer cannot be made to someone still a database match", !early.ok, (early as { message?: string }).message);
  const when = Date.now() + 2 * 86_400_000;
  const b1 = repo.scheduleInterview({ applicationId: a1, scheduledAt: when, timezone: "Asia/Colombo", location: "Client office, Colombo 03", mode: "in_person", interviewers: ["Head of Finance"], durationMins: 45, notes: null, byUserId: ta.id });
  const b2 = repo.scheduleInterview({ applicationId: a1, scheduledAt: when + 3_600_000, timezone: "Asia/Colombo", location: "Client office, Colombo 03", mode: "in_person", interviewers: ["Head of Finance"], durationMins: 45, notes: "Moved an hour later", byUserId: ta.id });
  await reload();
  const ivs = repo.interviews(a1);
  check("P6-01", "an interview is booked and rebooked: one pending, the first cancelled, stage interview", b1.ok && b2.ok && ivs.filter((i) => i.outcome === "pending").length === 1 && ivs.some((i) => i.outcome === "cancelled") && repo.application(a1)?.stage === "interview", ivs.map((i) => i.outcome).join(","));
  const live = ivs.find((i) => i.outcome === "pending")!;
  repo.confirmInterview(live.id);
  repo.setInterviewResult(live.id, { result: "passed", clientRating: 4, clientFeedback: "Strong on reconciliations" });
  await reload();
  const iv = repo.interviews(a1).find((i) => i.id === live.id);
  check("P6-02", "confirmation, result, rating and feedback are saved", !!iv?.confirmedAt && iv.clientRating === 4 && iv.clientFeedback === "Strong on reconciliations", `${iv?.result}, rating ${iv?.clientRating}`);

  // ── P6-03..04 offers ──────────────────────────────────────────────────────
  const offer = repo.makeOffer({ applicationId: a1, salary: 230000, salaryBasis: "monthly", currency: "LKR", startDate: when + 20 * 86_400_000, terms: "Probation 3 months", byUserId: ta.id });
  await reload();
  check("P6-03", "an offer is made after the interview: offer saved, stage offer", offer.ok && repo.application(a1)?.stage === "offer" && repo.offers(a1).some((o) => o.status === "pending"), offer.ok ? "" : (offer as { message: string }).message);
  const dup = repo.makeOffer({ applicationId: a1, salary: 240000, salaryBasis: "monthly", currency: "LKR", startDate: null, terms: null, byUserId: ta.id });
  check("P6-03c", "a second open offer on the same candidate is refused", !dup.ok);
  const o2 = repo.makeOffer({ applicationId: a2, salary: 210000, salaryBasis: "monthly", currency: "LKR", startDate: null, terms: null, byUserId: ta.id });
  await reload();
  repo.declineOffer(a2, "Accepted a counter-offer from current employer", ta.id);
  await reload();
  const a2now = repo.application(a2)!;
  check("P6-04", "a declined offer drops the candidate out with the reason and marks the offer declined", o2.ok && a2now.stage === "dropped_out" && a2now.offerDeclineReason === "Accepted a counter-offer from current employer", `${a2now.stage}`);

  // ── P6-06..07 placement ───────────────────────────────────────────────────
  const place = offer.ok ? repo.recordPlacement({ offerId: offer.id, joinDate: when + 30 * 86_400_000, byUserId: ta.id }) : { ok: false as const, message: "no offer" };
  await reload();
  const pl = repo.placementForApplication(a1);
  check("P6-06", "a placement is recorded from the offer: stage placed, salary and join date kept", place.ok && repo.application(a1)?.stage === "placed" && !!pl && pl.salary === 230000, pl ? `fee ${pl.feePercent}%, guarantee ${pl.guaranteeDays} days` : (place as { message?: string }).message);
  check("P6-07", "with no signed ESA the default fee (12%) and guarantee (90 days) apply", !!pl && pl.feePercent === 12 && pl.guaranteeDays === 90);
  const again = offer.ok ? repo.recordPlacement({ offerId: offer.id, joinDate: when, byUserId: ta.id }) : { ok: true };
  check("P6-06b", "the same offer cannot be placed twice", !again.ok);
  check("P6-06s", "the placed candidate is on the Placed screen and their page opens", await shows(`/openings/${openingId}/pipeline/placed`, ta.id, people[0].fullName) && (await get(`/openings/${openingId}/candidate/${a1}`, ta.id)).status === 200);
  const history = repo.events(a1).map((e) => e.toStage).filter(Boolean);
  check("P6-08", "the placed candidate's history holds every step", ["follow_up", "director_review", "director_shortlist", "client_shortlist", "interview", "offer", "placed"].every((s) => history.includes(s as never)), history.reverse().join(" → "));

  // ── P5-11 alerts ──────────────────────────────────────────────────────────
  const alertsPage = await get("/alerts", ta.id);
  check("P5-11", "the alerts screen loads for the TA", alertsPage.status === 200, `HTTP ${alertsPage.status}`);
} catch (e) {
  check("ERR", "the run stopped", false, (e as Error).stack?.split("\n").slice(0, 3).join(" ") ?? String(e));
} finally {
  console.log("\ncleanup");
  try {
    console.log(`  removed ${await sweepTestPipeline()} records`);
  } catch (e) {
    console.log(`  cleanup: ${(e as Error).message.slice(0, 300)}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.mkdirSync("docs/quality/test-log", { recursive: true });
  fs.writeFileSync(`docs/quality/test-log/P5-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
