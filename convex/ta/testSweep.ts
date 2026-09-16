// convex/ta/testSweep.ts
//
// Removes everything the end-to-end test scripts create, including what an
// interrupted run leaves: "C141 TEST" clients with their openings and every row
// hanging off them, candidates with an @c141-test.invalid address, and rows
// written since `since` that point at a deleted opening, application or
// candidate (inactive team assignments, call feedback, résumé rows).
//
// Internal, and refused outright unless the outbound lock is on — it exists for
// test deployments only. Nothing that is not test data or an orphan is touched.

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { outboundLocked } from "../lib/outboundGuard";

type Ctx = MutationCtx;

export const sweep = internalMutation({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    if (!outboundLocked()) throw new Error("testSweep runs only on a test deployment (C141_OUTBOUND_LOCK=true).");
    const removed: Record<string, number> = {};
    const del = async (table: string, id: string) => {
      await ctx.db.delete(id as never);
      removed[table] = (removed[table] ?? 0) + 1;
    };

    // ── test candidates ───────────────────────────────────────────────────────
    const recent = await ctx.db
      .query("candidates")
      .withIndex("by_firstSeenAt", (q) => q.gte("firstSeenAt", args.since))
      .collect();
    const testCandidates = recent.filter((c) => String(c.email ?? "").endsWith("@c141-test.invalid"));
    for (const c of testCandidates) await removeCandidate(ctx, c._id, del);

    // ── test clients, their openings and everything on them ──────────────────
    const clients = await ctx.db
      .query("clients")
      .withIndex("by_nameKey", (q) => q.gte("nameKey", "c141 test").lt("nameKey", "c141 tesu"))
      .collect();
    for (const client of clients) {
      const byId = await ctx.db.query("jobs").withIndex("by_clientId", (q) => q.eq("clientId", client._id)).collect();
      const byName = await ctx.db.query("jobs").withIndex("by_client", (q) => q.eq("clientName", client.name)).collect();
      const jobs = [...new Map([...byId, ...byName].map((j) => [j._id, j])).values()];
      for (const job of jobs) await removeOpening(ctx, job._id, del);
      for (const b of await ctx.db.query("briefs").withIndex("by_client", (q) => q.eq("clientId", client._id as never)).collect()) await del("briefs", b._id);
      for (const p of await ctx.db.query("placements").withIndex("by_clientId", (q) => q.eq("clientId", client._id as never)).collect()) await del("placements", p._id);
      await del("clients", client._id);
    }

    // ── orphans written during the test window ────────────────────────────────
    // Newest first, stopping at the window: these tables are large, and reading
    // them whole runs past the function's read limit.
    for await (const a of ctx.db.query("jobAssignments").order("desc")) {
      if (a._creationTime < args.since) break;
      if (!(await ctx.db.get(a.jobId))) await del("jobAssignments", a._id);
    }
    for await (const f of ctx.db.query("callFeedback").order("desc")) {
      if (f._creationTime < args.since) break;
      const appId = ctx.db.normalizeId("applications", String((f as { applicationId?: string }).applicationId ?? ""));
      if (!appId || !(await ctx.db.get(appId))) await del("callFeedback", f._id);
    }
    for await (const r of ctx.db.query("candidateResumes").order("desc")) {
      if (r._creationTime < args.since) break;
      if (!(await ctx.db.get(r.candidateId))) await del("candidateResumes", r._id);
    }
    return { removed, candidates: testCandidates.map((c) => c._id as string) };
  },
});

async function removeCandidate(ctx: Ctx, id: Id<"candidates">, del: (t: string, id: string) => Promise<void>) {
  for (const a of await ctx.db.query("applications").withIndex("by_candidateId", (q) => q.eq("candidateId", id)).collect()) {
    await removeApplication(ctx, a._id, del);
  }
  for (const r of await ctx.db.query("candidateResumes").withIndex("by_candidateId", (q) => q.eq("candidateId", id)).collect()) await del("candidateResumes", r._id);
  for (const r of await ctx.db.query("referees").withIndex("by_candidateId", (q) => q.eq("candidateId", id)).collect()) await del("referees", r._id);
  await del("candidates", id);
}

async function removeApplication(ctx: Ctx, id: Id<"applications">, del: (t: string, id: string) => Promise<void>) {
  const byApp = async (table: string, index: string) => {
    for (const r of await ctx.db.query(table as never).withIndex(index as never, (q: any) => q.eq("applicationId", id)).collect()) await del(table, (r as { _id: string })._id);
  };
  await byApp("pipelineEvents", "by_application");
  await byApp("interviews", "by_applicationId");
  await byApp("offers", "by_applicationId");
  await byApp("callFeedback", "by_application");
  await byApp("taOutreach", "by_application");
  await byApp("taScreeningCalls", "by_application");
  for (const r of await ctx.db.query("taAlerts").withIndex("by_subject", (q) => q.eq("subjectId", id)).collect()) await del("taAlerts", r._id);
  await del("applications", id);
}

async function removeOpening(ctx: Ctx, id: Id<"jobs">, del: (t: string, id: string) => Promise<void>) {
  for (const a of await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", id)).collect()) await removeApplication(ctx, a._id, del);
  for (const r of await ctx.db.query("jobAssignments").withIndex("by_jobId", (q) => q.eq("jobId", id)).collect()) await del("jobAssignments", r._id);
  for (const r of await ctx.db.query("placements").withIndex("by_jobId", (q) => q.eq("jobId", id)).collect()) await del("placements", r._id);
  for (const r of await ctx.db.query("pipelineEvents").withIndex("by_job_time", (q) => q.eq("jobId", id as never)).collect()) await del("pipelineEvents", r._id);
  for (const table of ["jobPosts", "reviewRounds", "linkVault", "profileSuggestions", "matchRuns", "matchExclusions", "sourcingChat", "benchmarks", "researchReports", "briefs"]) {
    for (const r of await ctx.db.query(table as never).withIndex("by_opening" as never, (q: any) => q.eq("openingId", id)).collect()) await del(table, (r as { _id: string })._id);
  }
  for (const r of await ctx.db.query("taAlerts").withIndex("by_subject", (q) => q.eq("subjectId", id)).collect()) await del("taAlerts", r._id);
  await del("jobs", id);
}
