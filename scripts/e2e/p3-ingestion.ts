/**
 * Phase 3 — a CV arriving by email, from the inbox to the candidate's profile.
 *
 * Reads real messages from a mailbox (read-only: no read flag, no move), sends
 * chosen ones through the same ingestion action production uses, targeted at a
 * C141 TEST opening, and follows each CV through upload, extraction, the
 * candidate profile, the search vector, scoring against the opening, and the
 * screens a TA reads. Files go to this deployment's own storage (the outbound
 * lock), never the production bucket. Everything created is removed at the end.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/e2e/p3-ingestion.ts
 *
 * Needs: local Convex with MS_GRAPH_* set, a dev server on :3177 with
 * C141_DEV_SIGNIN=on. P3_INBOX overrides the mailbox (default sanjeev@career141.com).
 */
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const { convexMutation, convexQuery, convexAction, convexConfig } = await import("@/lib/convexServer");

const BASE = "http://127.0.0.1:3177";
const INBOX = process.env.P3_INBOX ?? "sanjeev@career141.com";
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
const cookieFor = (id: string) => `c141_dev_user=${id}.${createHmac("sha256", `dev-signin:${secret()}`).update(id).digest("base64url")}`;
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
async function shows(path: string, userId: string, needle: string, waitMs = 45_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const res = await fetch(BASE + path, { headers: { cookie: cookieFor(userId) }, redirect: "manual" });
    const html = await res.text();
    if (html.includes(needle) || text(html).includes(needle)) return true;
    if (Date.now() > until) {
      console.log(`       ${path} → HTTP ${res.status}`);
      return false;
    }
    await sleep(5_000);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Internal functions go through the Convex CLI, which carries the admin key. */
function runInternal<T>(fn: string, args: unknown): T {
  const { url, adminKey } = convexConfig();
  const r = spawnSync(process.execPath, ["node_modules/convex/bin/main.js", "run", fn, JSON.stringify(args), "--url", url, "--admin-key", adminKey], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${fn}: ${(r.stderr || r.stdout).split("\n").filter((l) => /Error|error/.test(l)).join(" ").slice(0, 300)}`);
  const out = r.stdout.trim();
  const start = out.search(/[[{]/);
  return JSON.parse(start >= 0 ? out.slice(start) : out) as T;
}

type Cv = { id: string; name: string; contentType: string; size: number; fileHash: string; known: boolean };
type Msg = { messageId: string; subject: string; from: string; receivedAt: string; isRead: boolean; preview: string; cvs: Cv[] };
type Trace = {
  fileHash: string; uploads: number;
  upload: { id: string; createdAt: number; status: string; errorMessage: string | null; s3Key: string | null; storageProvider: string | null; assignToJob: string | null } | null;
  candidate: { id: string; createdAt: number; fullName: string | null; hasEmail: boolean; hasPhone: boolean; currentTitle: string | null; location: string | null; isParsed: boolean; skills: number; jobHistory: number; education: number; totalExperienceYears: number | null; rawTextKey: string | null; hasEmbedding: boolean } | null;
  resume: boolean;
  application: { id: string; stage: string; isActive: boolean; sourceChannel: string | null; aiMatchScore: number | null; explanation: string } | null;
  matchScores: number;
  logStages: string[];
};
const TA_STAGE: Record<string, string> = { new_cvs: "new_cv", matched_candidates: "matched", ta_shortlist: "follow_up", follow_up: "follow_up" };

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const since = Date.now();
let clientId = "";
let openingId = "";
let briefId = "";
const hashes: string[] = [];

try {
  await reload();
  const users = repo.users().filter((u) => u.isActive);
  const lead = users.find((u) => u.role === "ta_lead")!;
  const ta = users.find((u) => u.role === "ta")!;

  // ── P3-01 the mailbox, read-only ──────────────────────────────────────────
  console.log(`mailbox ${INBOX}`);
  const before = runInternal<Msg[]>("ta/inboxTest:listCvMessages", { inbox: INBOX, days: 60, limit: 30 });
  check("P3-01", "the mailbox is read with Microsoft Graph and CV attachments are listed", before.length > 0, `${before.length} messages with attachments`);
  const cvMsgs = before.filter((m) => !/invoice|deck|sponsor|nic\.pdf|birth|cost|\bal\.pdf|quote/i.test(m.cvs.map((c) => c.name).join(" ") + " " + m.subject));
  const fresh = cvMsgs.flatMap((m) => m.cvs.filter((c) => !c.known).map((c) => ({ m, c }))).slice(0, 2);
  const known = cvMsgs.flatMap((m) => m.cvs.filter((c) => c.known).map((c) => ({ m, c })))[0];
  const notCv = before.flatMap((m) => m.cvs.filter((c) => /invoice/i.test(c.name)).map((c) => ({ m, c })))[0];
  check("P3-01b", "the test set has new CVs, an already-known CV and a document that is not a CV", fresh.length >= 1 && !!known && !!notCv, `${fresh.length} new, ${known ? 1 : 0} known, ${notCv ? 1 : 0} not a CV`);

  // ── the C141 TEST opening the CVs are sent to ─────────────────────────────
  console.log("\nopening");
  clientId = await convexMutation<string>("ta/clients:add", { name: `C141 TEST Ingestion ${stamp}`, industry: "Testing", contacts: [] });
  const title = "AI-Powered Full-Stack Developer";
  briefId = realId(repo.createBrief({
    clientId, openingId: null, kind: "lead_to_ta", capturedBy: lead.id, capturedAt: Date.now(), method: "notes",
    notesMarkdown: "Full-stack developer, React/Next.js and Node, building AI features with LLM APIs. 2+ years.", transcript: null, transcriptStatus: "none",
    recordingKey: null, recordingDurationMs: null, consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null,
    extracted: { title } as never,
  }));
  openingId = realId(repo.createOpeningFromBrief(briefId, { clientId, jdMarkdown: "", taLeadId: lead.id, assignedTaIds: [ta.id], directorId: null, country: "Sri Lanka" }));
  repo.updateJd(openingId, `## ${title}\n\nBuild full-stack web applications with React, Next.js, TypeScript and Node.js. Integrate LLM APIs (OpenAI), vector search and automation. 2+ years of software engineering; a degree in computing or similar.`);
  repo.approveJd(openingId, ta.id);
  await reload({ allApplications: true, openingId });
  check("P3-02", "a test opening with an approved JD is open for CVs", repo.opening(openingId)?.jdStatus === "approved" && repo.opening(openingId)?.status === "open");

  // ── P3-03 send them through ingestion ─────────────────────────────────────
  console.log("\ningestion");
  const send = async (x: { m: Msg; c: Cv }) => {
    hashes.push(x.c.fileHash);
    await convexAction("communications/emailAgent:processSingleRecoveredEmail", {
      targetInboxEmail: INBOX, messageId: x.m.messageId, subject: x.m.subject, emailBody: x.m.preview,
      targetJobId: openingId, rawSender: x.m.from, extractionDelayMs: 0,
      cvAttachments: [{ id: x.c.id, name: x.c.name, contentType: x.c.contentType }],
    });
  };
  const sentAt = Date.now();
  for (const x of [...fresh, known, notCv].filter(Boolean) as { m: Msg; c: Cv }[]) await send(x);
  check("P3-03", "each message is accepted by the ingestion action", true, `${hashes.length} attachments sent`);

  // Wait for extraction and scoring to settle.
  // An applicant is settled once scored; the document that is not a CV once rejected.
  const wantsScore = new Set([...fresh, known].map((x) => x.c.fileHash));
  const settled = (t: Trace) =>
    !!t.upload && !["pending", "processing", "pending_retry"].includes(t.upload.status) &&
    (!wantsScore.has(t.fileHash) || (t.application?.aiMatchScore ?? null) !== null || Date.now() - sentAt > 240_000);
  let traces: Trace[] = [];
  const deadline = Date.now() + 300_000;
  for (;;) {
    traces = runInternal<Trace[]>("ta/ingestionTest:trace", { fileHashes: hashes, jobId: openingId });
    if (traces.every(settled) || Date.now() > deadline) break;
    await sleep(10_000);
  }
  const by = (h: string) => traces.find((t) => t.fileHash === h)!;

  // ── P3-04..10 each new CV ─────────────────────────────────────────────────
  const candidateIds: string[] = [];
  for (const [i, x] of fresh.entries()) {
    const t = by(x.c.fileHash);
    const tag = `#${i + 1}`;
    console.log(`\nnew CV ${tag}`);
    check("P3-04", `${tag} the file is stored in this deployment's own storage, not the production bucket`, !!t.upload?.s3Key?.startsWith("convex:"), t.upload?.s3Key?.slice(0, 20) ?? "no upload");
    check("P3-05", `${tag} the upload is processed`, t.upload?.status === "processed", `${t.upload?.status}${t.upload?.errorMessage ? `: ${t.upload.errorMessage.slice(0, 100)}` : ""}`);
    const c = t.candidate;
    if (c && c.createdAt < since) console.log("       (same person already on file: merged into their existing profile)");
    check("P3-06", `${tag} a candidate profile is extracted: name, contact, title, skills, history`, !!c && c.isParsed && !!c.fullName && (c.hasEmail || c.hasPhone) && c.skills > 0 && c.jobHistory + c.education > 0,
      c ? `${c.skills} skills, ${c.jobHistory} jobs, ${c.education} education, ${c.totalExperienceYears ?? "?"} yrs` : "no candidate");
    check("P3-07", `${tag} the CV text is kept and readable`, !!c?.rawTextKey && (!c.rawTextKey.startsWith("convex:") || (await convexAction<string | null>("storage/r2:getResumeRawText", { rawTextKey: c.rawTextKey }).catch(() => null) ?? "").length > 200), c?.rawTextKey?.slice(0, 20) ?? "none");
    check("P3-08", `${tag} the candidate is on the opening`, !!t.application?.isActive, t.application ? `${t.application.stage}, source ${t.application.sourceChannel}` : "no application");
    check("P3-09", `${tag} the CV is scored against the opening with an explanation`, typeof t.application?.aiMatchScore === "number" && t.application.explanation.length > 0 && t.matchScores > 0, `score ${t.application?.aiMatchScore}, ${t.matchScores} score rows`);
    if (c) candidateIds.push(c.id);
  }

  // ── P3-11 the known CV links, does not duplicate ──────────────────────────
  console.log("\nknown CV");
  const k = by(known.c.fileHash);
  check("P3-11", "a CV already in the database links the existing candidate, with no second upload or profile", k.uploads === 1 && !!k.candidate && k.candidate.createdAt < since && !!k.application, `${k.uploads} upload rows, ${k.application ? k.application.stage : "not linked"}`);
  check("P3-11b", "the returning candidate is scored against the new opening", typeof k.application?.aiMatchScore === "number", `score ${k.application?.aiMatchScore}`);

  // ── P3-12 not a CV ────────────────────────────────────────────────────────
  console.log("\nnot a CV");
  const n = by(notCv.c.fileHash);
  check("P3-12", "a document that is not a CV is rejected, with no candidate and nobody added to the opening", !!n.upload && !n.candidate && !n.application && /not recognized as a valid CV/i.test(n.upload.errorMessage ?? ""), `${n.upload?.status}: ${n.upload?.errorMessage?.slice(0, 90)}`);

  // ── P3-13 search vectors ──────────────────────────────────────────────────
  await sleep(5_000);
  const vec = candidateIds.length ? runInternal<Record<string, boolean>>("ta/inboxTest:vectors", { candidateIds }) : {};
  check("P3-13", "each new candidate has a search vector", candidateIds.length > 0 && candidateIds.every((id) => vec[id]), JSON.stringify(vec));

  // ── P3-14 the mailbox is unchanged ────────────────────────────────────────
  const after = runInternal<Msg[]>("ta/inboxTest:listCvMessages", { inbox: INBOX, days: 60, limit: 30 });
  const flags = (ms: Msg[]) => ms.map((m) => `${m.messageId.slice(-12)}:${m.isRead}`).sort().join();
  check("P3-14", "the mailbox is unchanged (no message marked read or moved)", flags(after) === flags(before));

  // ── P3-15 screens ─────────────────────────────────────────────────────────
  console.log("\nscreens");
  for (const [i, id] of candidateIds.entries()) {
    const t = traces.find((x) => x.candidate?.id === id)!;
    const name = t.candidate!.fullName!;
    check("P3-15", `#${i + 1} the candidate's profile opens with their name`, await shows(`/candidates/${id}`, ta.id, name));
    const stage = TA_STAGE[t.application?.stage ?? ""] ?? null;
    if (stage) check("P3-16", `#${i + 1} the TA sees them in the opening's ${stage} list`, await shows(`/openings/${openingId}/pipeline/${stage}`, ta.id, name), t.application?.stage);
  }
} catch (e) {
  check("ERR", "the run stopped", false, (e as Error).stack?.split("\n").slice(0, 3).join(" ") ?? String(e));
} finally {
  console.log("\ncleanup");
  try {
    if (openingId && hashes.length) {
      const r = runInternal<{ removed: Record<string, number>; candidates: string[] }>("ta/ingestionTest:cleanup", { fileHashes: hashes, jobId: openingId, since });
      if (r.candidates.length) runInternal("ta/inboxTest:vectors", { candidateIds: r.candidates, remove: true });
      console.log(`  ${JSON.stringify(r.removed)}`);
    }
    await reload({ allApplications: true });
    if (openingId) {
      const r = repo.deleteOpening(openingId);
      if (!r.ok) console.log(`  could not delete opening: ${(r as { message: string }).message}`);
    }
    await reload({ allApplications: true });
    const assignments = await convexQuery<{ rows: { id: string; openingId: string }[] }>("ta/tables:page", { table: "assignments", numItems: 1000 });
    await convexMutation("ta/storage:purgeTestAssignments", { assignmentIds: assignments.rows.filter((a) => a.openingId === openingId).map((a) => a.id) }).catch(() => undefined);
    const ops: { table: string; kind: string; key: string; before: object }[] = [];
    if (briefId) ops.push({ table: "briefs", kind: "delete", key: briefId, before: {} });
    if (clientId) ops.push({ table: "clients", kind: "delete", key: clientId, before: {} });
    if (ops.length) await convexMutation("ta/commit:apply", { ops });
  } catch (e) {
    console.log(`  cleanup: ${(e as Error).message.slice(0, 200)}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.mkdirSync("docs/quality/test-log", { recursive: true });
  fs.writeFileSync(`docs/quality/test-log/P3-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), inbox: INBOX, passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
