/**
 * Phase 4 — candidate profiles, CV structure, search and reverse matching,
 * against the local Convex backend (a copy of production's 77k candidates) and
 * on screen (a dev server on :3177 with C141_DEV_SIGNIN=on).
 *
 * Reads real candidates; writes only to a C141 TEST opening and a saved search,
 * both removed at the end. CV files are read from the production bucket
 * (read-only signed links).
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/e2e/p4-profiles-search.ts
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
const { convexMutation, convexQuery, convexAction } = await import("@/lib/convexServer");
/** Anything test data this run leaves is swept at the end (ta/testSweep). */
const SWEEP_SINCE = Date.now();
const { findDatabaseMatches } = await import("@/lib/dbMatch");
const backend = await import("@/data/convex/backend");

const BASE = "http://127.0.0.1:3177";
let passed = 0;
let failed = 0;
const results: { id: string; name: string; ok: boolean; detail: string }[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  results.push({ id, name, ok, detail });
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function reload(scope: Parameters<typeof primeStore>[0] = { allApplications: true }) {
  resetStore();
  await primeStore(scope);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieFor = (id: string) => `c141_dev_user=${id}.${createHmac("sha256", `dev-signin:${secret()}`).update(id).digest("base64url")}`;
const get = (path: string, userId: string) => fetch(BASE + path, { headers: { cookie: cookieFor(userId) }, redirect: "manual" });
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");
/** Polls: the dev server keeps its loaded tables for up to 30s, and compiles a page on its first visit. */
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

type Profile = {
  summary: string | null; career: { title: string; employer: string | null }[]; education: { degree: string | null; institution: string | null }[];
  cv: { fileName: string | null; fileType: string | null; storage: string } | null; cvText: string | null; cvTextInR2: boolean;
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
let clientId = "";
let briefId = "";
let openingId = "";
let savedId = "";

try {
  await reload();
  const users = repo.users().filter((u) => u.isActive);
  const lead = users.find((u) => u.role === "ta_lead")!;
  const ta = users.find((u) => u.role === "ta")!;

  // ── pick a real, fully extracted candidate with a PDF CV in the bucket ────
  console.log("candidate profile");
  let subject: { id: string; profile: Profile } | null = null;
  for (const term of ["Accountant", "Software Engineer", "Marketing Manager", "Sales Executive"]) {
    const ids = await convexQuery<string[]>("ta/candidates:quickSearch", { q: term, limit: 30 });
    for (const id of ids) {
      const view = (await backend.candidateProfile({ id: null }, id).catch(() => null)) as Profile | null;
      if (!view) continue;
      await reload({ candidateIds: [id] });
      const c = repo.candidate(id);
      if (!c || !view) continue;
      if (view.career.length >= 2 && view.education.length >= 1 && (c.skills?.length ?? 0) >= 3 && view.cv?.storage === "r2" && /pdf/i.test(`${view.cv.fileType} ${view.cv.fileName}`)) {
        subject = { id, profile: view };
        break;
      }
    }
    if (subject) break;
  }
  check("P4-01", "a real candidate with career, education, skills and a PDF CV is found in the database", !!subject);
  if (!subject) throw new Error("no suitable candidate");
  const c = repo.candidate(subject.id)!;
  const firstJob = subject.profile.career[0];
  const school = subject.profile.education.find((e) => e.institution)?.institution ?? "";

  // ── P4-02..04 the profile screen ──────────────────────────────────────────
  check("P4-02", "the profile screen shows the name, the career and the education", await shows(`/candidates/${c.id}`, ta.id, c.fullName) && await shows(`/candidates/${c.id}`, ta.id, firstJob.title, 5_000) && (!school || await shows(`/candidates/${c.id}`, ta.id, school, 5_000)), `${subject.profile.career.length} roles, ${subject.profile.education.length} education`);
  const cvRes = await get(`/api/cv/${c.id}`, ta.id);
  const loc = cvRes.headers.get("location") ?? "";
  const file = loc ? await fetch(loc) : null;
  const head = file?.ok ? Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString("latin1") : "";
  check("P4-03", "the CV file opens from the production bucket through the app (read-only link)", cvRes.status === 302 && head.startsWith("%PDF"), `HTTP ${cvRes.status} → ${file?.status ?? "-"} ${head.replace(/[^\x20-\x7e]/g, "")}`);
  check("P4-04", "the text read from the CV is available on the profile", (subject.profile.cvText?.length ?? 0) > 200 || subject.profile.cvTextInR2, `${subject.profile.cvText?.length ?? 0} chars${subject.profile.cvTextInR2 ? " (in storage)" : ""}`);

  // ── P4-05 quick search across the whole database ─────────────────────────
  console.log("\nsearch");
  await reload(); // the candidate is no longer loaded — the search must find them itself
  check("P4-05", "the top-bar search finds a person by name across the whole database", await shows(`/search?q=${encodeURIComponent(c.fullName)}`, ta.id, `/candidates/${c.id}`));

  // ── P4-06..07 database search ─────────────────────────────────────────────
  const role = c.currentTitle || firstJob.title;
  const ai = await convexAction<{ results?: unknown[] } | unknown[]>("matching/search:aiSearch", { query: `${role} with ${(c.skills ?? []).slice(0, 2).join(" and ")}` }).catch((e) => ({ error: (e as Error).message }));
  const aiCount = Array.isArray(ai) ? ai.length : Array.isArray((ai as { results?: unknown[] }).results) ? (ai as { results: unknown[] }).results.length : 0;
  check("P4-06", "the AI search returns candidates for a plain-language query", aiCount > 0, aiCount ? `${aiCount} results` : JSON.stringify(ai).slice(0, 160));
  const kw = await convexQuery<unknown[]>("matching/search:searchCandidates", { query: role, limit: 20 });
  check("P4-06b", "the keyword search (the fallback) returns candidates", kw.length > 0, `${kw.length} results`);
  const resultsPage = await get(`/database/results?q=${encodeURIComponent(role)}&mode=natural`, ta.id);
  const resultsHtml = await resultsPage.text();
  check("P4-06s", "the Database results screen lists people for that search", resultsPage.status === 200 && /(\/candidates\/|[?&;](c|candidate|open)=)[a-z0-9]{28,}/.test(resultsHtml), `HTTP ${resultsPage.status}`);
  const searchName = `C141 TEST search ${stamp}`;
  savedId = (await convexMutation<{ id: string }>("ta/search:saveSearch", { actorId: ta.id, name: searchName, query: role, mode: "natural", count: aiCount })).id;
  check("P4-07", "a saved search is stored and listed on the Database screen", await shows("/database", ta.id, searchName));

  // ── a C141 TEST opening written for this person's kind of role ────────────
  console.log("\nreverse matching");
  clientId = await convexMutation<string>("ta/clients:add", { name: `C141 TEST Matching ${stamp}`, industry: "Testing", contacts: [] });
  briefId = realId(repo.createBrief({
    clientId, openingId: null, kind: "lead_to_ta", capturedBy: lead.id, capturedAt: Date.now(), method: "notes", notesMarkdown: role,
    transcript: null, transcriptStatus: "none", recordingKey: null, recordingDurationMs: null, consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null,
    extracted: { title: role } as never,
  }));
  openingId = realId(repo.createOpeningFromBrief(briefId, { clientId, jdMarkdown: "", taLeadId: lead.id, assignedTaIds: [ta.id], directorId: null, country: "Sri Lanka" }));
  repo.updateJd(openingId, `## ${role}\n\nWe need a ${role}. Skills: ${(c.skills ?? []).slice(0, 8).join(", ")}. ${c.totalExperienceYears ? `${Math.max(1, Math.floor(c.totalExperienceYears / 2))}+ years of experience.` : ""} Location: ${c.location ?? "Colombo"}.`);
  repo.approveJd(openingId, ta.id);
  await reload({ allApplications: true, openingId, candidateIds: [c.id] });

  // ── P4-08 candidate → openings ────────────────────────────────────────────
  check("P4-08", "the profile lists openings the person may fit, with a score", await shows(`/candidates/${c.id}`, ta.id, "Openings they may fit") && await shows(`/candidates/${c.id}`, ta.id, `C141 TEST Matching ${stamp}`, 5_000));

  // ── P4-09..11 opening → candidates ────────────────────────────────────────
  const run = await findDatabaseMatches(openingId, "manual");
  await reload({ allApplications: true, openingId });
  const matched = repo.applications(openingId).filter((a) => a.stage === "matched");
  check("P4-09", "reverse matching adds database candidates to the opening as matches (at most 30)", run.ok && matched.length > 0 && matched.length <= 30, run.ok ? `${run.run?.added} added of ${run.run?.considered} considered, ${run.run?.afterRules} passed rules` : `not run: ${(run as { reason: string }).reason}`);
  const lastRun = repo.matchRuns(openingId)[0];
  check("P4-10", "the run is recorded with its counts", !!lastRun && lastRun.added === matched.length, lastRun ? `${lastRun.added} added, ${lastRun.considered} considered` : "no run");
  if (matched[0]) {
    const who = repo.candidate(matched[0].candidateId);
    check("P4-09s", "the matches are on the opening's Database CVs screen", !!who && await shows(`/openings/${openingId}/database`, ta.id, who.fullName));
    const removed = repo.removeApplication(matched[0].id);
    await findDatabaseMatches(openingId, "manual");
    await reload({ allApplications: true, openingId });
    const back = repo.applications(openingId).some((a) => a.candidateId === matched[0].candidateId);
    check("P4-11", "a match somebody removed is not added again by the next run", removed.ok && !back);
  }

  // ── P4-12 the prepared CV carries the CV's structure ──────────────────────
  console.log("\nprepared CV");
  // Loaded first, as the Add action does; they may already be on it from matching.
  await reload({ allApplications: true, openingId, candidateIds: [c.id] });
  const added = repo.addCandidateToOpening(c.id, openingId, ta.id);
  await reload({ allApplications: true, openingId, candidateIds: [c.id] });
  const app = repo.applications(openingId).find((a) => a.candidateId === c.id);
  // The dev server sees a new application once its loaded tables refresh (up to 30s).
  let pdfRes: Response | null = null;
  for (let i = 0; app && i < 10; i++) {
    pdfRes = await get(`/api/prepared-cv/${app.id}?current=${encodeURIComponent("RS 100K")}&expected=${encodeURIComponent("RS 150K")}`, ta.id);
    if (pdfRes.status !== 404) break;
    await sleep(5_000);
  }
  const pdf = pdfRes?.ok ? Buffer.from(await pdfRes.arrayBuffer()).toString("latin1") : "";
  const latin = (t: string) => t.replace(/[^\x20-\x7e]/g, "").slice(0, 25);
  check("P4-12", "the prepared CV is built from the extracted CV: career and education, with the Career141 block, no stand-in page",
    pdf.startsWith("%PDF") && pdf.includes("CAREER141 CANDIDATE") && pdf.includes("EXPERIENCE") && pdf.includes(latin(firstJob.title).replace(/[()\\]/g, "")) && !pdf.includes("Stand-in"),
    `${added.ok ? "" : `add refused (${(added as { reason?: string }).reason}); `}HTTP ${pdfRes?.status}, ${pdf.length} bytes`);
} catch (e) {
  check("ERR", "the run stopped", false, (e as Error).stack?.split("\n").slice(0, 3).join(" ") ?? String(e));
} finally {
  console.log("\ncleanup");
  try {
    // This run's saved search, and any left by an interrupted run.
    const taId = repo.users().find((u) => u.role === "ta" && u.isActive)?.id;
    const saved = taId ? await convexQuery<{ id: string; name: string }[]>("ta/search:savedSearches", { actorId: taId }).catch(() => []) : [];
    for (const row of saved.filter((x) => x.id === savedId || x.name.startsWith("C141 TEST search"))) {
      await convexMutation("ta/search:deleteSearch", { actorId: taId, searchId: row.id }).catch((e) => console.log(`  saved search: ${(e as Error).message.slice(0, 120)}`));
    }
    await reload({ allApplications: true, ...(openingId ? { openingId } : {}) });
    if (openingId) {
      for (const a of repo.applications(openingId)) repo.removeApplication(a.id);
      await reload({ allApplications: true, openingId });
      const ops: { table: string; kind: string; key: string; before: object }[] = [
        ...repo.matchRuns(openingId).map((r) => ({ table: "matchRuns", kind: "delete", key: r.id, before: {} })),
        ...[...repo.matchExcluded(openingId)].map((candidateId) => ({ table: "matchExclusions", kind: "delete", key: `${openingId}:${candidateId}`, before: { openingId, candidateId } })),
      ];
      if (ops.length) await convexMutation("ta/commit:apply", { ops });
      await reload({ allApplications: true });
      const r = repo.deleteOpening(openingId);
      if (!r.ok) console.log(`  could not delete opening: ${(r as { message: string }).message}`);
      await reload({ allApplications: true });
      const assignments = await convexQuery<{ rows: { id: string; openingId: string }[] }>("ta/tables:page", { table: "assignments", numItems: 1000 });
      await convexMutation("ta/storage:purgeTestAssignments", { assignmentIds: assignments.rows.filter((a) => a.openingId === openingId).map((a) => a.id) }).catch(() => undefined);
    }
    const ops: { table: string; kind: string; key: string; before: object }[] = [];
    if (briefId) ops.push({ table: "briefs", kind: "delete", key: briefId, before: {} });
    if (clientId) ops.push({ table: "clients", kind: "delete", key: clientId, before: {} });
    if (ops.length) await convexMutation("ta/commit:apply", { ops });
    console.log("  removed the test opening, its matches, runs and exclusions, the brief, client and saved search");
  } catch (e) {
    console.log(`  cleanup: ${(e as Error).message.slice(0, 200)}`);
  }
  await convexMutation<{ removed: Record<string, number> }>("ta/testSweep:sweep", { since: SWEEP_SINCE })
    .then((r) => { const n = Object.values(r.removed).reduce((a, b) => a + b, 0); if (n) console.log(`  sweep removed ${n} leftover rows`); })
    .catch((e) => console.log(`  sweep: ${(e as Error).message.slice(0, 160)}`));
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.mkdirSync("docs/quality/test-log", { recursive: true });
  fs.writeFileSync(`docs/quality/test-log/P4-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
