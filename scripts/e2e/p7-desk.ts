/**
 * Phase 7 — the screens that read across everything: headhunting suggestions
 * and the link vault, the browser extension, reports, dashboards, the desk
 * assistant and snippets. Local Convex backend, dev server on :3177 with
 * C141_DEV_SIGNIN=on. Test data only (C141 TEST client, @c141-test.invalid
 * candidates); everything is removed at the end.
 *
 * Paid web research, benchmarking and the sourcing chat's live search are not
 * run here: their screens are checked to load, and their saved records are
 * exercised through the store.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/e2e/p7-desk.ts
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
const { convexMutation } = await import("@/lib/convexServer");
/** Anything test data this run leaves is swept at the end (ta/testSweep). */
const SWEEP_SINCE = Date.now();
const { reportCsv, runReport, DEFAULT_SPEC } = await import("@/lib/reporting");

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
const post = (path: string, userId: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(BASE + path, { method: "POST", headers: { cookie: cookieFor(userId), "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");
async function shows(path: string, userId: string, needle: string, waitMs = 90_000): Promise<boolean> {
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
/** Retries while the dev server has not yet loaded rows this script just wrote. */
async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, waitMs = 45_000): Promise<T> {
  const end = Date.now() + waitMs;
  for (;;) {
    const x = await fn();
    if (ok(x) || Date.now() > end) return x;
    await sleep(5_000);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
let clientId = "";
let briefId = "";
let openingId = "";
let reportId = "";
let ownerId = "";
const candidateIds: string[] = [];
const title = `QA Payroll Specialist ${stamp.slice(11)}`;
const reload = async () => {
  resetStore();
  await primeStore({ allApplications: true, ...(openingId ? { openingId } : {}), candidateIds });
};

try {
  resetStore();
  await primeStore({ allApplications: true });
  const users = repo.users().filter((u) => u.isActive);
  const lead = users.find((u) => u.role === "ta_lead")!;
  const ta = users.find((u) => u.role === "ta")!;
  const director = users.find((u) => u.role === "director");
  const ops = users.find((u) => u.role === "ops");

  // ── setup ─────────────────────────────────────────────────────────────────
  console.log("setup");
  clientId = await convexMutation<string>("ta/clients:add", { name: `C141 TEST Desk ${stamp}`, industry: "Testing", contacts: [] });
  briefId = realId(repo.createBrief({
    clientId, openingId: null, kind: "lead_to_ta", capturedBy: lead.id, capturedAt: Date.now(), method: "notes", notesMarkdown: "Payroll specialist.",
    transcript: null, transcriptStatus: "none", recordingKey: null, recordingDurationMs: null, consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null,
    extracted: { title } as never,
  }));
  openingId = realId(repo.createOpeningFromBrief(briefId, { clientId, jdMarkdown: "", taLeadId: lead.id, assignedTaIds: [ta.id], directorId: director?.id ?? null, country: "Sri Lanka" }));
  repo.updateJd(openingId, `## ${title}\n\nRun monthly payroll for 800 staff; EPF/ETF filings; 3+ years.`);
  repo.approveJd(openingId, ta.id);
  repo.setAssignments(openingId, [{ userId: ta.id, role: "primary_recruiter" }, { userId: lead.id, role: "supporting_recruiter" }, ...(director ? [{ userId: director.id, role: "director" as const }] : [])], lead.id);
  const people = [1, 2].map((i) => ({
    id: `tmpdesk_${stamp}_${i}`, fullName: `Qadesk Person${i} ${stamp.slice(14, 16)}${stamp.slice(17, 19)}`, email: `desk${i}.${stamp.slice(11)}@c141-test.invalid`, phone: null,
    linkedinUrl: null, location: "Colombo", nationality: "Sri Lankan", age: null, gender: null, currentEmployer: "Test Holdings", currentTitle: "Payroll Executive",
    totalExperienceYears: 4, educationDegree: null, educationInstitution: null, qualifications: null, englishLevel: null, languages: [], skills: ["Payroll", "EPF"], industries: [],
    noticePeriodDays: null, currentSalary: null, expectedSalary: null, cvFileName: null, workHistory: [], createdAt: Date.now(),
  }));
  const made = await convexMutation<{ ids: Record<string, string> }>("ta/commit:apply", { ops: people.map((p) => ({ table: "candidates", kind: "insert", key: p.id, after: p })) });
  for (const p of people) candidateIds.push(made.ids[p.id]);
  await reload();
  for (const id of candidateIds) repo.addCandidateToOpening(id, openingId, ta.id);
  await reload();
  check("P7-00", "a test opening with an approved JD and two test candidates", repo.applications(openingId).length === 2 && repo.opening(openingId)?.jdStatus === "approved");

  // ── P7-03 suggestions ─────────────────────────────────────────────────────
  console.log("\nheadhunting");
  const sugg = [1, 2].map((i) => ({
    openingId, name: `QA Suggested ${i} ${stamp.slice(11)}`, headline: "Payroll Lead", company: "Example Co", location: "Colombo",
    linkedinUrl: `https://www.linkedin.com/in/c141-test-${stamp.slice(11).toLowerCase()}-${i}`, tier: "priority" as const, why: "Runs payroll for 1,000 staff.",
    concern: null, sourceUrl: null, status: "new" as const, feedback: null, round: 1, generatedAt: Date.now(), generatedFor: ta.id,
  }));
  repo.addSuggestions(openingId, sugg);
  repo.addSuggestions(openingId, [sugg[0]]);
  await reload();
  const saved = repo.suggestions(openingId);
  check("P7-03a", "suggestions are saved, and the same profile offered again is not added twice", saved.length === 2, `${saved.length} suggestions`);
  repo.setSuggestionStatus(saved[0].id, "kept", "more_like_this", ta.id);
  repo.setSuggestionStatus(saved[1].id, "dismissed", "not_relevant", ta.id);
  await reload();
  const after = repo.suggestions(openingId);
  const kept = after.find((s) => s.id === saved[0].id);
  const dismissed = after.find((s) => s.id === saved[1].id);
  check("P7-03", "keeping one claims it for the TA; dismissing the other records the feedback", kept?.status === "kept" && kept.keptBy === ta.id && dismissed?.status === "dismissed" && dismissed.feedback === "not_relevant");
  check("P7-03s", "the suggestions screen shows the kept profile", await shows(`/openings/${openingId}/hh/suggestions?show=kept`, ta.id, sugg[0].name));

  // ── P7-05 browser extension capture ───────────────────────────────────────
  const token = repo.setting("extension.token", "").trim() || (await import("@/lib/extension")).extensionToken();
  await reload();
  const profileUrl = `https://www.linkedin.com/in/c141-test-capture-${stamp.slice(11).toLowerCase()}`;
  const cap = await until(
    () => post("/api/extension/capture", ta.id, { openingId, userId: ta.id, profile: { sourceUrl: profileUrl, fullName: `QA Captured ${stamp.slice(11)}`, headline: "Payroll Manager", currentTitle: "Payroll Manager", currentCompany: "Example Co", location: "Colombo", experience: [{ title: "Payroll Manager", company: "Example Co", dates: "2021 - Present" }] } }, { "x-c141-token": token }).then(async (r) => ({ status: r.status, body: await r.text() })),
    (x) => x.status !== 404,
  );
  await reload();
  const links = repo.linkVault(openingId);
  check("P7-05", "a LinkedIn profile captured by the extension lands in the opening's link vault for that TA", cap.status < 300 && links.some((l) => l.addedBy === ta.id), `HTTP ${cap.status} ${cap.body.slice(0, 100)}; ${links.length} links`);
  const bad = await post("/api/extension/capture", ta.id, { openingId, userId: ta.id, profile: { sourceUrl: profileUrl } }, { "x-c141-token": "wrong" });
  check("P7-05b", "a capture with the wrong extension token is refused", bad.status === 401, `HTTP ${bad.status}`);
  for (const p of ["hh", "hh/research", "hh/links", "snippets"]) {
    const r = await get(`/openings/${openingId}/${p}`, ta.id);
    check("P7-01", `the ${p} screen loads`, r.status === 200, `HTTP ${r.status}`);
  }
  check("P7-11", "the snippet card carries the opening's real title", await shows(`/openings/${openingId}/snippets`, ta.id, title));

  // ── P7-06 reports ─────────────────────────────────────────────────────────
  console.log("\nreports and dashboards");
  const reportsPage = await get("/reports", lead.id);
  check("P7-06a", "the reports screen loads for the lead", reportsPage.status === 200, `HTTP ${reportsPage.status}`);
  ownerId = lead.id;
  const spec = { ...DEFAULT_SPEC };
  reportId = realId(repo.saveReport({ name: `C141 TEST report ${stamp}`, ownerId: lead.id, shared: false, spec }));
  await reload();
  check("P7-06b", "a report is saved and listed for its owner, not for another TA", repo.savedReports(lead.id).some((r) => r.name === `C141 TEST report ${stamp}`) && !repo.savedReports(ta.id).some((r) => r.name === `C141 TEST report ${stamp}`));
  const csvRes = await get(`/api/reports/report.csv?spec=${encodeURIComponent(JSON.stringify(spec))}&name=test`, lead.id);
  const csv = await csvRes.text();
  await reload();
  const direct = runReport({ ...spec, limit: 100_000 });
  const csvLines = csv.replace(/^﻿/, "").trim().split(/\r?\n/).length - 1;
  check("P7-06", "the CSV export has the same rows as the report computed straight from the database", csvRes.status === 200 && Math.abs(csvLines - direct.rows.length) <= 1 && reportCsv(spec).length > 0, `CSV ${csvLines} rows, database ${direct.rows.length}`);

  // ── P7-07 dashboards ──────────────────────────────────────────────────────
  for (const u of [lead, ta, director, ops].filter(Boolean) as typeof users) {
    const r = await get("/", u.id);
    const body = await r.text();
    check("P7-07", `the home dashboard loads for the ${u.role}`, r.status === 200 && !/Application error|Unhandled Runtime Error/.test(body), `HTTP ${r.status}`);
  }

  // ── P7-08..10 the desk assistant ──────────────────────────────────────────
  console.log("\nassistant");
  const q = await post("/api/assistant", ta.id, { question: "How many openings am I working on?" });
  const qa = (await q.json().catch(() => ({}))) as { type?: string; answer?: string; error?: string };
  check("P7-08", "the assistant answers a desk question", q.status === 200 && !!qa.answer, `HTTP ${q.status} ${(qa.answer ?? qa.error ?? "").slice(0, 120)}`);

  const target = people[0].fullName;
  const ask = () => post("/api/assistant", ta.id, { question: `shortlist ${target} for ${title}` }).then((r) => r.json() as Promise<{ type?: string; proposal?: { token: string; summary: string }; text?: string; error?: string }>);
  const proposal = await until(ask, (x) => x.type === "proposal");
  check("P7-09a", "an instruction to shortlist becomes a proposal to confirm", proposal.type === "proposal" && !!proposal.proposal?.token, proposal.proposal?.summary ?? proposal.text ?? proposal.error);
  if (proposal.proposal) {
    if (ops) {
      const stranger = await post("/api/assistant/confirm", ops.id, { token: proposal.proposal.token });
      check("P7-10", "someone else cannot confirm a proposal made for the TA", stranger.status !== 200, `HTTP ${stranger.status}`);
    }
    const done = await post("/api/assistant/confirm", ta.id, { token: proposal.proposal.token });
    const dj = (await done.json()) as { ok: boolean; message: string };
    await reload();
    const app = repo.applications(openingId).find((a) => a.candidateId === candidateIds[0]);
    check("P7-09", "confirming shortlists them exactly as the button does: owned by the TA, in follow-up, with a set", dj.ok && app?.stage === "follow_up" && app.ownerTaId === ta.id && app.setNumber !== null, dj.message);
    const replay = await post("/api/assistant/confirm", ta.id, { token: proposal.proposal.token });
    check("P7-09b", "the same confirmation cannot be used twice", replay.status !== 200, `HTTP ${replay.status}`);
  }
  // Leads, directors and ops act across the whole desk by design; a TA acts only
  // on openings they are assigned to.
  const outsider = users.find((u) => u.role === "ta" && u.id !== ta.id) ?? users.find((u) => u.role === "viewer");
  if (outsider) {
    const outsiderAsk = await post("/api/assistant", outsider.id, { question: `shortlist ${people[1].fullName} for ${title}` });
    const oj = (await outsiderAsk.json().catch(() => ({}))) as { type?: string; text?: string };
    check("P7-10b", `a ${outsider.role} who is not on the opening is not offered the change`, oj.type !== "proposal", `${oj.type}: ${(oj.text ?? "").slice(0, 100)}`);
  } else {
    check("P7-10b", "a TA who is not on the opening is not offered the change", true, "no second TA or viewer account on this desk — skipped");
  }
} catch (e) {
  check("ERR", "the run stopped", false, (e as Error).stack?.split("\n").slice(0, 3).join(" ") ?? String(e));
} finally {
  console.log("\ncleanup");
  try {
    resetStore();
    await primeStore({ allApplications: true });
    if (reportId && ownerId) repo.deleteReport(reportId, ownerId);
    const testClients = repo.clients().filter((c) => c.name.startsWith("C141 TEST Desk")).map((c) => c.id);
    if (clientId && !testClients.includes(clientId)) testClients.push(clientId);
    const openings = repo.openings().filter((o) => testClients.includes(o.clientId));
    const tail: { table: string; kind: string; key: string; before: object }[] = [];
    const testCandidates = new Set(candidateIds);
    for (const o of openings) {
      resetStore();
      await primeStore({ allApplications: true, openingId: o.id });
      for (const a of repo.applications(o.id)) testCandidates.add(a.candidateId);
      const ev = repo.openingEvents(o.id, 100_000).map((e) => ({ table: "pipelineEvents", kind: "delete", key: e.id, before: {} }));
      if (ev.length) await convexMutation("ta/commit:apply", { ops: ev });
      resetStore();
      await primeStore({ allApplications: true, openingId: o.id });
      const r = repo.deleteOpening(o.id);
      if (!r.ok) console.log(`  could not delete opening: ${(r as { message: string }).message}`);
      if (o.briefId) tail.push({ table: "briefs", kind: "delete", key: o.briefId, before: {} });
    }
    if (briefId && !tail.some((t) => t.key === briefId)) tail.push({ table: "briefs", kind: "delete", key: briefId, before: {} });
    resetStore();
    await primeStore({ allApplications: true, candidateIds: [...testCandidates] });
    for (const id of testCandidates) if (repo.candidate(id)?.email?.endsWith("@c141-test.invalid")) tail.push({ table: "candidates", kind: "delete", key: id, before: {} });
    for (const c of testClients) tail.push({ table: "clients", kind: "delete", key: c, before: {} });
    if (tail.length) await convexMutation("ta/commit:apply", { ops: tail });
    console.log(`  removed ${openings.length} openings and ${tail.length} other records`);
  } catch (e) {
    console.log(`  cleanup: ${(e as Error).message.slice(0, 300)}`);
  }
  await convexMutation<{ removed: Record<string, number> }>("ta/testSweep:sweep", { since: SWEEP_SINCE })
    .then((r) => { const n = Object.values(r.removed).reduce((a, b) => a + b, 0); if (n) console.log(`  sweep removed ${n} leftover rows`); })
    .catch((e) => console.log(`  sweep: ${(e as Error).message.slice(0, 160)}`));
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.mkdirSync("docs/quality/test-log", { recursive: true });
  fs.writeFileSync(`docs/quality/test-log/P7-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
