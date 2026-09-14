/**
 * C141_LIVE_CONVEX_URL=https://api.career141.com node --import ./tests/alias.mjs scripts/live-test/decisions-inventory.ts
 *
 * Read-only (14 September): reads every application in the current system, one
 * query at a time, and keeps only what tells a human decision from an automated
 * one — ids, stage, stage history (stage + whether a user or "system" made it),
 * who shortlisted, AI score present, rejection reason present. No notes, names,
 * contacts or CV text. Saves .data-live-test/inventory/applications-<ts>.jsonl.
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }
const { ReadOnlyConvex, READ_FUNCTIONS, liveConvexConfigFromEnv } = await import("@/lib/live/readOnlyConvex");
const config = liveConvexConfigFromEnv();
if (!config) { console.error("Live link not configured."); process.exit(1); }
const live = new ReadOnlyConvex({ ...config, rate: 3 });

const ids: string[] = [];
let cursor: string | undefined;
for (;;) {
  const p = await live.query<{ ids: string[]; isDone: boolean; continueCursor: string }>(READ_FUNCTIONS.idsPage, cursor ? { table: "applications", cursor } : { table: "applications" });
  ids.push(...p.ids);
  if (p.isDone) break;
  cursor = p.continueCursor;
}
console.log(`applications: ${ids.length}`);
const dir = path.join(process.cwd(), ".data-live-test", "inventory");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `applications-${Date.now()}.jsonl`);
const out = fs.createWriteStream(file);
const isUser = (by: unknown) => typeof by === "string" && by !== "system" && by.length > 0;
let n = 0, failed = 0;
for (const id of ids) {
  try {
    const a: any = await live.query(READ_FUNCTIONS.applicationById, { id });
    if (!a) { failed++; continue; }
    out.write(JSON.stringify({
      id: a._id, jobId: a.jobId, candidateId: a.candidateId, created: a._creationTime ? new Date(a._creationTime).toISOString().slice(0, 10) : null,
      stage: a.currentStage ?? null, active: a.isActive ?? null, source: a.sourceChannel ?? null,
      history: Array.isArray(a.stageHistory) ? a.stageHistory.map((h: any) => ({ stage: h.stage, byUser: isUser(h.changedBy), at: h.enteredAt ? new Date(h.enteredAt).toISOString().slice(0, 10) : null })) : [],
      taShortlistBy: isUser(a.taShortlistById), taShortlistStatus: a.taShortlistStatus ?? null,
      secondShortlistBy: isUser(a.secondShortlistById), directorReviewBy: isUser(a.directorReviewId),
      aiMatchScore: typeof a.aiMatchScore === "number" ? a.aiMatchScore : null,
      rejectedFromStage: a.rejectedFromStage ?? null, hasRejectionReason: Boolean(a.taRejectionReason),
      manualCallOutcome: a.manualCallOutcome ?? null, aiCallStatus: a.aiCallStatus ?? null,
    }) + "\n");
  } catch (e) { failed++; if (failed < 5) console.log("failed", (e as Error).message.slice(0, 120)); }
  if (++n % 500 === 0) console.log(`${n}/${ids.length} read`);
}
out.end();
console.log(`done ${n} read, ${failed} failed · ${live.requests} requests · saved ${file}`);
process.exit(0);
