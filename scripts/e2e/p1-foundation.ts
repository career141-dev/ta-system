/**
 * Phase 1 — the write path, against the local Convex backend.
 *
 * Every check reads back from the database after throwing the in-memory copy
 * away, so "passed" means stored, not merely held. Creates a marked test client
 * ("C141 TEST …") and opening, uses one real candidate as the applicant, and
 * removes everything it created at the end — including when a check fails.
 *
 *   node --conditions=react-server --import ./tests/alias.mjs scripts/e2e/p1-foundation.ts
 */
import fs from "node:fs";
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
const { convexMutation, convexQuery } = await import("@/lib/convexServer");

let passed = 0;
let failed = 0;
const results: { id: string; name: string; ok: boolean; detail: string }[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  results.push({ id, name, ok, detail });
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function reload(scope: Parameters<typeof primeStore>[0] = { allApplications: true }) {
  resetStore();
  await primeStore(scope);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const created: { table: string; key: string }[] = [];
const CANDIDATE = "j978dmw7t74ccwe7q5hdy4wtw98ec5gw";

try {
  await reload({ allApplications: true, candidateIds: [CANDIDATE] });
  const lead = repo.users().find((u) => u.isActive && u.role === "ta_lead");
  const ta2 = repo.users().find((u) => u.isActive && u.role === "ta" && u.id !== lead?.id);
  if (!lead || !ta2) throw new Error("Need an active TA Lead and a second TA on the desk to run these checks.");
  console.log(`acting as ${lead.name} (lead) and ${ta2.name} (TA)\n`);

  // ── clients ────────────────────────────────────────────────────────────────
  console.log("clients and openings");
  const clientName = `C141 TEST ${stamp}`;
  const tempClient = repo.addClient({ name: clientName, industry: "Testing", contacts: [{ name: "Test Contact", title: "HR", email: "qa@c141-test.invalid", isPrimary: true }] });
  const clientId = realId(tempClient);
  created.push({ table: "clients", key: clientId });
  check("P1-00", "a new client gets a real database id", clientId !== tempClient && !clientId.startsWith("cl_"), clientId);
  check("P1-00b", "the temporary id still finds it in the same request", repo.client(tempClient)?.name === clientName);
  await reload();
  check("P2-03", "the client is in the database after a reload", repo.client(clientId)?.name === clientName);

  // ── opening from a brief ───────────────────────────────────────────────────
  const briefId = realId(
    repo.createBrief({
      clientId,
      openingId: null,
      kind: "lead_to_ta",
      capturedBy: lead.id,
      capturedAt: Date.now(),
      method: "notes",
      notesMarkdown: "Test brief for the Phase 1 write path.",
      transcript: null,
      transcriptStatus: "none",
      recordingKey: null,
      recordingDurationMs: null,
      consentAcknowledgedBy: null,
      consentAcknowledgedAt: null,
      consentText: null,
      extracted: { title: `QA Test Role ${stamp}` } as never,
    }),
  );
  created.push({ table: "briefs", key: briefId });
  const openingId = realId(
    repo.createOpeningFromBrief(briefId, {
      clientId,
      jdMarkdown: "## Test role\nPhase 1 test opening — safe to delete.",
      taLeadId: lead.id,
      assignedTaIds: [lead.id, ta2.id],
      directorId: null,
    }),
  );
  created.push({ table: "openings", key: openingId });
  await reload({ allApplications: true, openingId });
  const opening = repo.opening(openingId);
  check("P2-05", "the opening is stored with its title, client, lead and JD", !!opening && opening.title === `QA Test Role ${stamp}` && opening.clientId === clientId && opening.taLeadId === lead.id && opening.jdMarkdown.includes("Phase 1"), opening ? `${opening.title}, JD ${opening.jdStatus}` : "not found");
  check("P2-05b", "the brief is linked to the opening", repo.brief(briefId)?.openingId === openingId, String(repo.brief(briefId)?.openingId));

  // ── team ───────────────────────────────────────────────────────────────────
  repo.setAssignments(openingId, [{ userId: lead.id, role: "primary_recruiter" }, { userId: ta2.id, role: "supporting_recruiter" }], lead.id);
  await reload({ allApplications: true, openingId });
  const team = repo.assignments(openingId);
  check("P2-09", "the team is stored as active assignments", team.length === 2, `${team.length} assignments`);

  // ── an applicant, claimed ──────────────────────────────────────────────────
  console.log("\npipeline");
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const added = repo.addCandidateToOpening(CANDIDATE, openingId, lead.id);
  // Returns only whether it worked; the application is found by who and where.
  const appId: string = repo.applications(openingId).find((a) => a.candidateId === CANDIDATE)?.id ?? "";
  if (appId) created.push({ table: "applications", key: appId });
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const app0 = repo.application(appId);
  check("P1-01a", "a candidate added to the opening is stored as an application", !!app0 && app0.openingId === openingId && app0.candidateId === CANDIDATE, app0 ? `stage ${app0.stage}` : JSON.stringify(added));

  const claim = repo.shortlist(appId, lead.id);
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const app1 = repo.application(appId);
  check("P1-01", "claiming a candidate is stored: owner, set, stage", claim.ok && app1?.ownerTaId === lead.id && app1?.stage === "follow_up" && app1?.setNumber != null, app1 ? `owner ${app1.ownerTaId === lead.id ? "lead" : app1.ownerTaId}, set ${app1.setNumber}, ${app1.stage}` : "gone");
  const events = repo.events(appId);
  check("P1-01b", "the move is in the application's history", events.some((e) => e.toStage === "follow_up"), `${events.length} events`);

  // ── two people at once ─────────────────────────────────────────────────────
  // ta2's copy was loaded before the lead's change below reaches the database.
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const stale = repo.application(appId)!;
  await convexMutation("ta/commit:apply", {
    ops: [{ table: "applications", kind: "update", key: appId, before: stale, after: { ...stale, rating: 4 }, changed: ["rating"] }],
  });
  let conflictMessage = "";
  try {
    repo.addApplicationNote(appId, "note written from a stale copy", ta2.id);
    // addApplicationNote does not touch rating, so it must succeed…
  } catch (e) {
    conflictMessage = (e as Error).message;
  }
  check("P1-02a", "a change to a different field of the same record is not a conflict", conflictMessage === "", conflictMessage);
  // …but setting the rating from the stale copy must be refused.
  let refused = "";
  try {
    const db = repo.application(appId)!;
    void db;
    repo.batch(() => {
      const a = repo.application(appId)! as unknown as { rating: number | null };
      a.rating = 1;
    });
  } catch (e) {
    refused = (e as Error).message;
  }
  check("P1-02", "an edit to a field someone else just changed is refused, not overwritten", /Someone else changed/.test(refused), refused || "was saved");
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  check("P1-02b", "the other person's value is the one kept", repo.application(appId)?.rating === 4, `rating ${repo.application(appId)?.rating}`);
  check("P1-02c", "the non-conflicting note was stored", (repo.application(appId)?.notes ?? []).some((n) => n.includes("stale copy")));

  // ── all or nothing ─────────────────────────────────────────────────────────
  const ghostName = `C141 TEST ghost ${stamp}`;
  let atomicError = "";
  try {
    await convexMutation("ta/commit:apply", {
      ops: [
        { table: "clients", kind: "insert", key: "cl_ghost001", after: { name: ghostName, industry: "x", contacts: [], esaSignedAt: null, status: "active", createdAt: Date.now() } },
        { table: "applications", kind: "update", key: "not-a-real-id", before: {}, after: {}, changed: ["rating"] },
      ],
    });
  } catch (e) {
    atomicError = (e as Error).message;
  }
  await reload();
  check("P1-03", "a commit that fails part-way writes nothing", !!atomicError && !repo.clients().some((c) => c.name === ghostName), atomicError.slice(0, 80));

  // ── write, then read, in one action (the old crash) ────────────────────────
  console.log("\nclosing records");
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const toClient = repo.moveStage(appId, "client_shortlist", lead.id, undefined, { force: true });
  check("P1-09a", "a forced move to client shortlist is stored", toClient.ok && repo.application(appId)?.stage === "client_shortlist", JSON.stringify(toClient));
  const iv = repo.scheduleInterview({
    applicationId: appId,
    scheduledAt: Date.now() + 3 * 86_400_000,
    timezone: "Asia/Colombo",
    location: "Test room",
    mode: "video",
    interviewers: ["QA Panel"],
    durationMins: 30,
    notes: "Phase 1 test interview",
    byUserId: lead.id,
  });
  const ivId = realId((iv as { id?: string }).id ?? "");
  if (ivId) created.push({ table: "interviews", key: ivId });
  check("P1-09", "scheduling an interview — a write followed by a stage move — no longer crashes", (iv as { ok?: boolean }).ok !== false, JSON.stringify(iv).slice(0, 100));
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const ivRow = repo.interviews().find((i) => i.applicationId === appId);
  check("P6-01", "the interview is stored and the application moved to interview", !!ivRow && repo.application(appId)?.stage === "interview", ivRow ? `${ivRow.mode}, round ${ivRow.round}` : "no interview row");
  const rawIv = ivRow ? await convexQuery<Record<string, unknown> | null>("ta/tables:page", { table: "interviews", numItems: 1000 }).then((p) => (p as unknown as { rows: Record<string, unknown>[] }).rows.find((r) => r.id === ivRow.id) ?? null) : null;
  check("P6-01b", "the interview reads back with its fields intact", !!rawIv && rawIv.location === "Test room" && (rawIv.interviewers as string[])[0] === "QA Panel");

  const offer = repo.makeOffer({ applicationId: appId, salary: 250_000, salaryBasis: "monthly", currency: "LKR", startDate: Date.now() + 30 * 86_400_000, terms: "Test terms", byUserId: lead.id } as never);
  const offerId = realId((offer as { id?: string }).id ?? "");
  if (offerId) created.push({ table: "offers", key: offerId });
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const offerRow = repo.offers(appId)[0];
  check("P6-03", "an offer is stored and the application moved to offer", !!offerRow && offerRow.salary === 250_000 && repo.application(appId)?.stage === "offer", offerRow ? `${offerRow.currency} ${offerRow.salary} ${offerRow.status}` : JSON.stringify(offer).slice(0, 100));

  const placement = offerRow ? repo.recordPlacement({ offerId: offerRow.id, joinDate: Date.now() + 30 * 86_400_000, byUserId: lead.id }) : { ok: false, message: "no offer" };
  const placementId: string = realId(placement.ok && "id" in placement ? String(placement.id) : "");
  if (placementId) created.push({ table: "placements", key: placementId });
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  const placed = repo.placements({ openingId })[0];
  check("P6-06", "a placement is stored with fee and guarantee, and the application is placed", !!placed && placed.guaranteeDays > 0 && repo.application(appId)?.stage === "placed", placed ? `fee ${placed.feePercent}%, ${placed.guaranteeDays} days` : placement.ok ? "not found" : (placement as { message: string }).message);

  // ── the TA-only tables ─────────────────────────────────────────────────────
  console.log("\ndesk records");
  const linkId = realId(repo.addLink(openingId, "https://www.linkedin.com/in/c141-test-profile", lead.id));
  created.push({ table: "linkVault", key: linkId });
  const searchId = realId(repo.saveSearch({ name: `QA search ${stamp}`, query: "Brand Manager in Colombo", mode: "natural", ownerId: lead.id, openingId, count: 18 }));
  created.push({ table: "savedSearches", key: searchId });
  repo.recordCall({ applicationId: appId, kind: "ad_hoc", outcome: "reached", body: "Test call note", structured: null, source: "manual", recordedBy: lead.id });
  repo.setSetting("c141.testSetting", stamp);
  await reload({ allApplications: true, openingId, candidateIds: [CANDIDATE] });
  check("P1-04a", "link vault", repo.linkVault(openingId).some((l) => l.id === linkId));
  check("P1-04b", "saved searches", repo.savedSearches().some((s) => s.id === searchId));
  const call = repo.callFeedback(appId).find((f) => f.body === "Test call note");
  if (call) created.push({ table: "callFeedback", key: call.id });
  check("P1-04c", "call feedback", !!call);
  check("P1-04d", "settings", repo.setting("c141.testSetting", "") === stamp, repo.setting("c141.testSetting", "(none)"));
} catch (e) {
  check("ERR", "the run stopped", false, (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e));
} finally {
  // ── clean up, newest first ─────────────────────────────────────────────────
  console.log("\ncleanup");
  await reload({ allApplications: true });
  const extra: { table: string; key: string }[] = [];
  const appIds = new Set(created.filter((c) => c.table === "applications").map((c) => c.key));
  for (const r of await convexQuery<{ rows: { id: string; applicationId: string }[] }>("ta/tables:page", { table: "pipelineEvents", numItems: 1000 }).then((p) => p.rows)) {
    if (appIds.has(r.applicationId)) extra.push({ table: "pipelineEvents", key: r.id });
  }
  for (const r of await convexQuery<{ rows: { id: string; openingId: string }[] }>("ta/tables:page", { table: "assignments", numItems: 1000 }).then((p) => p.rows)) {
    if (created.some((c) => c.table === "openings" && c.key === r.openingId)) extra.push({ table: "assignmentsHard", key: r.id });
  }
  const ops = [...extra.filter((x) => x.table !== "assignmentsHard"), ...created.slice().reverse()].map((c) => ({ table: c.table, kind: "delete", key: c.key, before: {} }));
  ops.push({ table: "settings", kind: "delete", key: "c141.testSetting", before: { key: "c141.testSetting" } } as never);
  try {
    await convexMutation("ta/commit:apply", { ops });
    await convexMutation("ta/storage:purgeTestAssignments", { assignmentIds: extra.filter((x) => x.table === "assignmentsHard").map((x) => x.key) });
    console.log(`  removed ${ops.length} test rows`);
  } catch (e) {
    console.log(`  cleanup failed: ${(e as Error).message.slice(0, 200)}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.mkdirSync("docs/quality/test-log", { recursive: true });
  fs.writeFileSync(`docs/quality/test-log/P1-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
