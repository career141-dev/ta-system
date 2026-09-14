/**
 * node --import ./tests/alias.mjs scripts/live-test/inventory.ts
 *
 * Read-only resource inventory of the current (legacy) system, 14 September.
 * Query functions only, over the allow-listed read link, paced. Saves counts
 * and job-level summaries (no candidate names, contacts or CV text) to
 * .data-live-test/inventory/live-<timestamp>.json. Costs nothing.
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }

const { ReadOnlyConvex, READ_FUNCTIONS, liveConvexConfigFromEnv } = await import("@/lib/live/readOnlyConvex");
const { ReadOnlyQdrant, liveQdrantConfigFromEnv } = await import("@/lib/live/readOnlyQdrant");

const config = liveConvexConfigFromEnv();
if (!config) { console.error("Live link not configured."); process.exit(1); }
const live = new ReadOnlyConvex({ ...config, rate: Math.min(config.rate ?? 3, 3) });
const started = Date.now();
const out: Record<string, unknown> = { at: new Date().toISOString(), source: new URL(config.url).host };

type Page = { count: number; isDone: boolean; continueCursor: string; activeCount?: number };
async function countAll(fn: (typeof READ_FUNCTIONS)[keyof typeof READ_FUNCTIONS], limit = 500) {
  let cursor: string | null = null, total = 0, active = 0, pages = 0;
  for (;;) {
    const p: Page = await live.query<Page>(fn, { cursor, limit });
    total += p.count; active += p.activeCount ?? 0; pages++;
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  return { total, pages, ...(fn === READ_FUNCTIONS.countJobsPage ? { active } : {}) };
}
async function countIds(table: string) {
  let cursor: string | undefined, total = 0;
  try {
    for (;;) {
      const p = await live.query<{ ids: string[]; isDone: boolean; continueCursor: string }>(READ_FUNCTIONS.idsPage, cursor ? { table, cursor } : { table });
      total += p.ids.length;
      if (p.isDone) return { total };
      cursor = p.continueCursor;
    }
  } catch (e) {
    return { total: null, partial: total, error: (e as Error).message.slice(0, 160) };
  }
}
const step = async <T,>(name: string, f: () => Promise<T>) => {
  process.stdout.write(`${name}… `);
  try { const v = await f(); out[name] = v; console.log(JSON.stringify(v).slice(0, 200)); }
  catch (e) { out[name] = { error: (e as Error).message.slice(0, 200) }; console.log("error", (e as Error).message.slice(0, 120)); }
};

await step("jobCounts", () => live.query(READ_FUNCTIONS.jobCounts, {}));
await step("jobsTotal", () => countAll(READ_FUNCTIONS.countJobsPage, 200));
await step("candidatesTotal", () => countAll(READ_FUNCTIONS.countCandidatesPage));
await step("cvUploadsTotal", () => countAll(READ_FUNCTIONS.countCvUploadsPage));
await step("applicationsTotal", () => countAll(READ_FUNCTIONS.countApplicationsPage));
const tables: Record<string, unknown> = {};
for (const t of ["candidateResumes", "pipelineEvents", "match_scores", "aiCalls", "voiceCallSessions", "voiceAnswers", "communications",
  "directorReviews", "clientReviews", "interviews", "offers", "placements", "candidateInquiries", "pipeline", "cvs", "documents", "whatsappSessions", "followUpSequences"]) {
  process.stdout.write(`${t}… `);
  tables[t] = await countIds(t);
  console.log(JSON.stringify(tables[t]));
}
out.tableRows = tables;

// Jobs of every status: aggregate what exists per job, no candidate data.
await step("jobs", async () => {
  const jobs: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const p: { page: Record<string, any>[]; isDone: boolean; continueCursor: string } =
      await live.query(READ_FUNCTIONS.jobsPage, { paginationOpts: { numItems: 25, cursor } });
    for (const j of p.page) {
      const stages = (j.stageCounts ?? {}) as Record<string, number>;
      jobs.push({
        id: j._id, keyword: j.keyword ?? null, title: j.title ?? null, status: j.status ?? null,
        createdAt: j._creationTime ? new Date(j._creationTime).toISOString().slice(0, 10) : null,
        filledAt: j.filledAt ? new Date(j.filledAt).toISOString().slice(0, 10) : null,
        jdChars: String(j.jobDescription ?? "").length,
        requiredSkills: Array.isArray(j.requiredSkills) ? j.requiredSkills.length : 0,
        hasClientName: Boolean(j.clientName), hasClientIndustry: Boolean(j.clientIndustry), hasSeniority: Boolean(j.seniorityLevel ?? j.seniority),
        totalApplications: j.totalApplications ?? 0, stageCounts: stages,
      });
    }
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  const byStatus: Record<string, number> = {};
  const stageTotals: Record<string, number> = {};
  for (const j of jobs as any[]) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    for (const [s, n] of Object.entries(j.stageCounts as Record<string, number>)) stageTotals[s] = (stageTotals[s] ?? 0) + (Number(n) || 0);
  }
  const HUMAN_ONLY = ["director_shortlist", "client_review", "interview", "offer", "placed"];
  return {
    count: jobs.length, byStatus, stageTotals,
    withJd300: jobs.filter((j: any) => j.jdChars >= 300).length,
    withClientName: jobs.filter((j: any) => j.hasClientName).length,
    withAnyHumanOnlyStage: jobs.filter((j: any) => HUMAN_ONLY.some((s) => (j.stageCounts[s] ?? 0) > 0)).length,
    jobs,
  };
});

const q = liveQdrantConfigFromEnv();
await step("qdrant", async () => {
  if (!q) return "not configured";
  const info: any = await new ReadOnlyQdrant(q).info();
  return { points: info.points_count ?? null, width: info.config?.params?.vectors?.size ?? null };
});

out.seconds = Math.round((Date.now() - started) / 1000);
out.requests = live.requests;
const dir = path.join(process.cwd(), ".data-live-test", "inventory");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `live-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\nsaved ${file} · ${out.requests} requests · ${out.seconds}s`);
process.exit(0);
