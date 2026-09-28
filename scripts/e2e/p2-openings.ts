/**
 * Phase 2 — people, clients and openings, against the local Convex backend,
 * and the same records on screen (a dev server on :3177 with C141_DEV_SIGNIN=on).
 *
 * Uses the paths the server actions use: the clients' own Convex mutations for
 * clients, the store for openings, JDs, teams, posts and status. Every database
 * check reloads from Convex first. Screen checks fetch the real pages signed in
 * as the TA Lead and look for the record in the HTML. Everything created is
 * removed at the end.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/e2e/p2-openings.ts
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
const { can } = await import("@/lib/auth");
const { secret } = await import("@/lib/sign");
const { convexMutation, convexQuery } = await import("@/lib/convexServer");
/** Anything test data this run leaves is swept at the end (ta/testSweep). */
const SWEEP_SINCE = Date.now();

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
const cookieFor = (id: string) => `c141_dev_user=${id}.${createHmac("sha256", `dev-signin:${secret()}`).update(id).digest("base64url")}`;
async function page(path: string, userId: string): Promise<{ status: number; headers: string; html: string }> {
  const res = await fetch(BASE + path, { headers: { cookie: cookieFor(userId) }, redirect: "manual" });
  return { status: res.status, headers: res.headers.get("location") ?? "", html: await res.text() };
}
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

/**
 * Whether a screen shows a value. The dev server keeps its own loaded copy of
 * the tables for up to 30s, so a row written by this script can take that long
 * to appear; poll rather than fail. The page's server-rendered props (the RSC
 * payload) count: an editor fills itself from them in the browser.
 */
async function shows(path: string, userId: string, needle: string, waitMs = 90_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await page(path, userId);
    const html = r.html;
    const raw = html.replace(/\\"/g, '"').replace(/\n/g, "\n").replace(/\u2014/g, "\u2014");
    if (text(html).includes(needle) || raw.includes(needle) || html.includes(needle)) return true;
    if (Date.now() > until) {
      const i = text(html).indexOf("Job description");
      console.log(`       ${path} → HTTP ${r.status} ${r.headers ?? ""}: ${text(html).slice(Math.max(0, i), Math.max(0, i) + 300)}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const cleanup: { kind: string; id: string }[] = [];

try {
  await reload();
  const users = repo.users().filter((u) => u.isActive);
  const lead = users.find((u) => u.role === "ta_lead")!;
  const ta = users.find((u) => u.role === "ta")!;
  const admin = users.find((u) => u.role === "admin");
  const director = users.find((u) => u.role === "director");
  const ops = users.find((u) => u.role === "ops");

  // ── P2-01 roles ────────────────────────────────────────────────────────────
  console.log("roles");
  const matrix: [string, typeof lead | undefined, string, boolean][] = [
    ["lead manages clients", lead, "client.manage", true],
    ["TA cannot manage clients", ta, "client.manage", false],
    ["ops cannot manage clients", ops, "client.manage", false],
    ["lead creates openings", lead, "opening.create", true],
    ["TA creates openings", ta, "opening.create", true],
    ["TA reads the database", ta, "database.read", true],
    ["only admin manages people", admin, "user.manage", true],
    ["director does not manage people", director, "user.manage", false],
  ];
  for (const [name, u, cap, want] of matrix) {
    if (!u) { check("P2-01", name, true, "no such account on this desk — skipped"); continue; }
    check("P2-01", name, can(u, cap as never).ok === want);
  }
  for (const [path, who, want] of [["/clients", lead, 200], ["/people", lead, 200], ["/reports", ta, 200], ["/openings/new", ta, 200]] as const) {
    const r = await page(path, who.id);
    check("P2-01s", `${who.role} opens ${path}`, r.status === want, `HTTP ${r.status}`);
  }

  // ── P2-03 / P2-04 clients (the action's own mutations) ─────────────────────
  console.log("\nclients");
  const clientName = `C141 TEST Client ${stamp}`;
  const clientId = await convexMutation<string>("ta/clients:add", {
    name: clientName,
    industry: "Testing",
    contacts: [{ name: "Main Contact", title: "HR Manager", email: "qa@c141-test.invalid", isPrimary: true }],
  });
  cleanup.push({ kind: "client", id: clientId });
  const dup = await convexMutation<string>("ta/clients:add", { name: clientName.toLowerCase(), industry: "Testing", contacts: [] }).catch((e) => `refused: ${(e as Error).message}`);
  check("P2-03a", "the same client name twice does not create a second client", dup === clientId || String(dup).startsWith("refused"), String(dup).slice(0, 80));
  await convexMutation("ta/clients:update", { clientId, name: clientName, industry: "Quality Assurance", status: "active", esaSignedAt: Date.parse("2026-09-01") });
  await convexMutation("ta/clients:saveContacts", {
    clientId,
    contacts: [
      { name: "Main Contact", title: "HR Manager", email: "qa@c141-test.invalid", isPrimary: false },
      { name: "Second Contact", title: "Finance", email: "qa2@c141-test.invalid", isPrimary: true },
    ],
  });
  await reload();
  const client = repo.client(clientId);
  check("P2-03", "client saved with edits, ESA date and two contacts", !!client && client.industry === "Quality Assurance" && client.contacts.length === 2 && client.contacts.find((c) => c.isPrimary)?.name === "Second Contact" && client.esaSignedAt === Date.parse("2026-09-01"), client ? `${client.industry}, ${client.contacts.length} contacts` : "not found");
  check("P2-03s", "the client is on the Clients screen", await shows("/clients", lead.id, clientName));

  // ── P2-05 opening from a brief ─────────────────────────────────────────────
  console.log("\nopening");
  const title = `QA Brand Manager ${stamp}`;
  const briefId = realId(repo.createBrief({
    clientId, openingId: null, kind: "lead_to_ta", capturedBy: lead.id, capturedAt: Date.now(), method: "notes",
    notesMarkdown: "Brand Manager for a consumer goods client, Colombo, 5+ years.", transcript: null, transcriptStatus: "none",
    recordingKey: null, recordingDurationMs: null, consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null,
    extracted: { title } as never,
  }));
  cleanup.push({ kind: "brief", id: briefId });
  const openingId = realId(repo.createOpeningFromBrief(briefId, { clientId, jdMarkdown: "", taLeadId: lead.id, assignedTaIds: [ta.id], directorId: director?.id ?? null, country: "Sri Lanka" }));
  cleanup.push({ kind: "opening", id: openingId });
  await reload({ allApplications: true, openingId });
  const o1 = repo.opening(openingId);
  check("P2-05", "opening saved from the brief: title, client, lead, pending JD, open", !!o1 && o1.title === title && o1.clientId === clientId && o1.jdStatus !== "approved" && o1.status === "open", o1 ? `${o1.jdStatus}, ${o1.status}` : "not found");
  check("P2-05b", "the brief points at the opening", repo.brief(briefId)?.openingId === openingId);
  check("P2-05s", "the assigned TA sees it in their openings list", await shows("/openings", ta.id, title));

  // ── P2-06 / P2-07 JD ───────────────────────────────────────────────────────
  console.log("\njob description");
  const jd = `## ${title}\n\nOwn the brand plan and campaign calendar. 5+ years in FMCG brand management.`;
  repo.updateJd(openingId, jd);
  repo.approveJd(openingId, ta.id);
  await reload({ allApplications: true, openingId });
  const o2 = repo.opening(openingId)!;
  check("P2-06", "JD saved and approved with who and when", o2.jdMarkdown === jd && o2.jdStatus === "approved" && o2.jdApprovedBy === ta.id && !!o2.jdApprovedAt, `${o2.jdStatus} by ${o2.jdApprovedBy === ta.id ? "the TA" : o2.jdApprovedBy}`);
  repo.updateJd(openingId, `${jd}\n\nAmended: hybrid working.`);
  await reload({ allApplications: true, openingId });
  const o3 = repo.opening(openingId)!;
  check("P2-07", "an amendment is saved and the JD stays approved", o3.jdMarkdown.includes("Amended: hybrid") && o3.jdStatus === "approved");
  check("P2-07s", "the amended JD is on the JD screen", await shows(`/openings/${openingId}/jd`, ta.id, "Amended: hybrid working"));

  // ── P2-08 details ──────────────────────────────────────────────────────────
  repo.updateOpening(openingId, { salaryMin: 300000, salaryMax: 450000, salaryCurrency: "LKR", headcount: 2, priorityTier: "P2", locations: ["Colombo", "Kandy"] } as never);
  await reload({ allApplications: true, openingId });
  const o4 = repo.opening(openingId)!;
  check("P2-08", "details saved: salary range, headcount, tier, two locations", o4.salaryMin === 300000 && o4.salaryMax === 450000 && o4.headcount === 2 && o4.priorityTier === "P2" && o4.locations.join() === "Colombo,Kandy", `${o4.salaryMin}-${o4.salaryMax}, ${o4.headcount}, ${o4.priorityTier}, ${o4.locations.join("/")}`);

  // ── P2-09 team ─────────────────────────────────────────────────────────────
  console.log("\nteam and posts");
  // The store refuses silently; the proof is that the team did not change.
  const teamBefore = repo.assignments(openingId).map((a) => `${a.userId}:${a.role}`).sort().join();
  try { repo.setAssignments(openingId, [{ userId: (director ?? lead).id, role: "director" }], lead.id); } catch { /* refused loudly is fine too */ }
  await reload({ allApplications: true, openingId });
  const teamAfter = repo.assignments(openingId).map((a) => `${a.userId}:${a.role}`).sort().join();
  check("P2-09a", "a team with no recruiter is refused", teamAfter === teamBefore && teamAfter.includes(ta.id), teamAfter || "team emptied");
  repo.setAssignments(openingId, [{ userId: ta.id, role: "primary_recruiter" }, { userId: lead.id, role: "supporting_recruiter" }, ...(director ? [{ userId: director.id, role: "director" as const }] : [])], lead.id);
  await reload({ allApplications: true, openingId });
  const team = repo.assignments(openingId);
  check("P2-09", "team saved with each role", team.some((a) => a.userId === ta.id && a.role === "primary_recruiter") && team.some((a) => a.userId === lead.id && a.role === "supporting_recruiter"), team.map((a) => a.role).join(", "));

  // ── P2-10 posts ────────────────────────────────────────────────────────────
  const draft = repo.addJobPost(openingId, `${title} — LinkedIn`, ta.id, false, "linkedin");
  const postId: string = repo.jobPosts(openingId).find((p) => p.title === `${title} — LinkedIn`)?.id ?? "";
  await reload({ allApplications: true, openingId });
  check("P2-10", "a job post is saved as a draft", !!repo.jobPosts(openingId).find((p) => p.id === postId && p.status === "draft"), JSON.stringify(draft).slice(0, 80));
  const live = repo.updatePost(postId, { status: "live" });
  await reload({ allApplications: true, openingId });
  const post = repo.jobPosts(openingId).find((p) => p.id === postId);
  check("P2-10b", "setting it live after approval is saved with a posted time", live.ok && post?.status === "live" && !!post?.postedAt, `${post?.status}`);
  check("P2-10s", "the post is on the LinkedIn Job screen", await shows(`/openings/${openingId}/linkedin-job`, ta.id, `${title} — LinkedIn`));

  // Live before approval, on a second opening that has no approved JD.
  const brief2 = realId(repo.createBrief({ clientId, openingId: null, kind: "lead_to_ta", capturedBy: lead.id, capturedAt: Date.now(), method: "notes", notesMarkdown: "x", transcript: null, transcriptStatus: "none", recordingKey: null, recordingDurationMs: null, consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null, extracted: { title: `QA Unapproved ${stamp}` } as never }));
  cleanup.push({ kind: "brief", id: brief2 });
  const opening2 = realId(repo.createOpeningFromBrief(brief2, { clientId, jdMarkdown: "", taLeadId: lead.id, assignedTaIds: [ta.id], directorId: null }));
  cleanup.push({ kind: "opening", id: opening2 });
  const early = repo.addJobPost(opening2, "Too early", ta.id, true, "linkedin");
  check("P2-10c", "a post cannot go live before the JD is approved", !early.ok, (early as { message?: string }).message ?? "was allowed");

  // ── P2-04 delete a client with openings ────────────────────────────────────
  // Delete moves a client to the Bin (ta/bin.ts), and refuses while openings are filed under it.
  const held = await convexMutation<{ ok: boolean; openings?: number }>("ta/bin:binClient", { actorId: lead.id, clientId });
  check("P2-04", "deleting a client with openings is refused with the count", !held.ok && (held.openings ?? 0) >= 1, JSON.stringify(held));

  // ── P2-11 status ───────────────────────────────────────────────────────────
  console.log("\nstatus and delete");
  repo.setOpeningStatus(openingId, "on_hold");
  await reload({ allApplications: true, openingId });
  const held2 = { ...repo.opening(openingId)! };
  repo.setOpeningStatus(openingId, "closed");
  await reload({ allApplications: true, openingId });
  const closed = { ...repo.opening(openingId)! };
  repo.setOpeningStatus(openingId, "open");
  await reload({ allApplications: true, openingId });
  const reopened = { ...repo.opening(openingId)! };
  check("P2-11", "hold, close and reopen are saved with position status and closed time", held2.status === "on_hold" && held2.positionStatus === "hold" && closed.status === "closed" && !!closed.closedAt && reopened.status === "open" && reopened.positionStatus === "active", `${held2.status}/${held2.positionStatus} → ${closed.status}/${closed.closedAt ? "closedAt" : "-"} → ${reopened.status}/${reopened.positionStatus}`);

  // ── P2-12 delete ───────────────────────────────────────────────────────────
  const del = repo.deleteOpening(opening2);
  await reload({ allApplications: true });
  check("P2-12", "an opening with no offers is deleted", del.ok && !repo.opening(opening2), JSON.stringify(del).slice(0, 80));
  if (del.ok) cleanup.splice(cleanup.findIndex((c) => c.id === opening2), 1);
} catch (e) {
  check("ERR", "the run stopped", false, (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e));
} finally {
  console.log("\ncleanup");
  await reload({ allApplications: true });
  for (const c of cleanup.filter((x) => x.kind === "opening")) {
    const r = repo.deleteOpening(c.id);
    if (!r.ok) console.log(`  could not delete opening ${c.id}: ${(r as { message: string }).message}`);
  }
  await reload({ allApplications: true });
  const assignments = await convexQuery<{ rows: { id: string; openingId: string }[] }>("ta/tables:page", { table: "assignments", numItems: 1000 });
  const gone = new Set(cleanup.filter((c) => c.kind === "opening").map((c) => c.id));
  await convexMutation("ta/storage:purgeTestAssignments", { assignmentIds: assignments.rows.filter((a) => gone.has(a.openingId)).map((a) => a.id) }).catch(() => undefined);
  const ops = cleanup.filter((c) => c.kind === "brief").map((c) => ({ table: "briefs", kind: "delete", key: c.id, before: {} }));
  for (const c of cleanup.filter((x) => x.kind === "client")) ops.push({ table: "clients", kind: "delete", key: c.id, before: {} });
  if (ops.length) await convexMutation("ta/commit:apply", { ops }).catch((e) => console.log(`  cleanup: ${(e as Error).message.slice(0, 160)}`));
  console.log(`  removed ${cleanup.length} records`);
  await convexMutation<{ removed: Record<string, number> }>("ta/testSweep:sweep", { since: SWEEP_SINCE })
    .then((r) => { const n = Object.values(r.removed).reduce((a, b) => a + b, 0); if (n) console.log(`  sweep removed ${n} leftover rows`); })
    .catch((e) => console.log(`  sweep: ${(e as Error).message.slice(0, 160)}`));
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.mkdirSync("docs/quality/test-log", { recursive: true });
  fs.writeFileSync(`docs/quality/test-log/P2-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
