// convex/ta/openingAccess.ts
//
// Requesting access is deliberately separate from reading an opening. An
// unassigned TA can discover only the small directory projection below; the
// normal opening layout continues to refuse its JD, candidates and pipeline.

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireActor } from "./guard";
import { isGone } from "../../src/lib/bin";

type Ctx = QueryCtx | MutationCtx;

function roleOf(user: Doc<"users">): string {
  if (user.taRole) return user.taRole;
  if (user.role === "ta_manager" || user.role === "senior_ta") return "ta_lead";
  if (user.role === "recruiter" || user.role === "test_ta") return "ta";
  return user.role;
}

function requireRequester(user: Doc<"users">): void {
  if (!["ta", "ta_support"].includes(roleOf(user))) {
    throw new Error("Only a TA can request access to an opening.");
  }
}

function requestable(job: Doc<"jobs">): boolean {
  return !isGone(job) && job.status === "active" && !job.isConfidential;
}

async function activeAssignment(ctx: Ctx, jobId: Id<"jobs">, userId: Id<"users">) {
  return ctx.db
    .query("jobAssignments")
    .withIndex("by_jobId_userId", (q) => q.eq("jobId", jobId).eq("userId", userId))
    .filter((q) => q.eq(q.field("isActive"), true))
    .first();
}

async function isAssigned(ctx: Ctx, job: Doc<"jobs">, userId: Id<"users">): Promise<boolean> {
  return (job.assignedTaIds ?? []).includes(userId) || !!(await activeAssignment(ctx, job._id, userId));
}

export const listAvailable = internalQuery({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    requireRequester(user);

    const [jobs, assignments, requests, users] = await Promise.all([
      ctx.db.query("jobs").collect(),
      ctx.db
        .query("jobAssignments")
        .withIndex("by_userId_isActive", (q) => q.eq("userId", user._id).eq("isActive", true))
        .collect(),
      ctx.db
        .query("openingAccessRequests")
        .withIndex("by_requester_job", (q) => q.eq("requesterId", user._id))
        .collect(),
      ctx.db.query("users").collect(),
    ]);
    const assigned = new Set(assignments.map((row) => row.jobId as string));
    const usersById = new Map(users.map((row) => [row._id as string, row]));
    const names = new Map(users.map((row) => [row._id as string, row.fullName]));

    return jobs
      .filter((job) => requestable(job))
      .filter((job) => {
        const lead = job.taLeadId ? usersById.get(job.taLeadId as string) : null;
        return !!lead?.isActive && roleOf(lead) === "ta_lead";
      })
      .filter((job) => !assigned.has(job._id as string) && !(job.assignedTaIds ?? []).includes(user._id))
      .map((job) => {
        const latest = requests
          .filter((row) => row.jobId === job._id)
          .sort((a, b) => b.requestedAt - a.requestedAt)[0];
        return {
          id: job._id as string,
          title: job.title,
          clientName: job.clientName,
          positionCode: job.positionCode ?? null,
          leadName: job.taLeadId ? names.get(job.taLeadId as string) ?? "TA Lead" : "No TA Lead",
          assignedTaNames: (job.assignedTaIds ?? []).map((id) => names.get(id as string)).filter(Boolean),
          requestStatus: latest?.status ?? null,
          requestedAt: latest?.requestedAt ?? null,
        };
      })
      .sort((a, b) => `${a.clientName} ${a.title}`.localeCompare(`${b.clientName} ${b.title}`));
  },
});

export const listPendingForApprover = internalQuery({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const role = roleOf(actor);
    if (role !== "ta_lead" && role !== "admin") return [];

    const requests = role === "admin"
      ? (await ctx.db.query("openingAccessRequests").collect()).filter((row) => row.status === "pending")
      : await ctx.db
          .query("openingAccessRequests")
          .withIndex("by_lead_status", (q) => q.eq("leadId", actor._id).eq("status", "pending"))
          .collect();

    const result = [];
    for (const request of requests) {
      const [job, requester] = await Promise.all([
        ctx.db.get(request.jobId),
        ctx.db.get(request.requesterId),
      ]);
      if (!job || !requester) continue;
      result.push({
        id: request._id as string,
        openingId: job._id as string,
        openingTitle: job.title,
        clientName: job.clientName,
        requesterName: requester.fullName,
        requestReason: request.requestReason ?? null,
        requestedAt: request.requestedAt,
      });
    }
    return result.sort((a, b) => a.requestedAt - b.requestedAt);
  },
});

export const request = internalMutation({
  args: {
    actorId: v.string(),
    openingId: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const requester = await requireActor(ctx, args.actorId);
    requireRequester(requester);
    const jobId = ctx.db.normalizeId("jobs", args.openingId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!job || !requestable(job)) throw new Error("That opening is not available for access requests.");
    if (await isAssigned(ctx, job, requester._id)) return { ok: true, alreadyAssigned: true };

    const lead = job.taLeadId ? await ctx.db.get(job.taLeadId) : null;
    if (!lead?.isActive || roleOf(lead) !== "ta_lead") {
      throw new Error("This opening does not have an active TA Lead. Ask an administrator to assign one.");
    }
    const reason = args.reason?.trim() ?? "";
    if (reason.length > 1000) throw new Error("Keep the reason under 1,000 characters.");

    const duplicate = await ctx.db
      .query("openingAccessRequests")
      .withIndex("by_requester_job_status", (q) =>
        q.eq("requesterId", requester._id).eq("jobId", job._id).eq("status", "pending"),
      )
      .first();
    if (duplicate) return { ok: true, alreadyPending: true, id: duplicate._id as string };

    const now = Date.now();
    const id = await ctx.db.insert("openingAccessRequests", {
      jobId: job._id,
      requesterId: requester._id,
      leadId: lead._id,
      status: "pending",
      requestReason: reason || undefined,
      requestedAt: now,
    });
    await ctx.db.insert("notifications", {
      userId: lead._id,
      type: "opening_access_requested",
      title: "Opening access requested",
      body: `${requester.fullName} requested access to ${job.title}.`,
      jobId: job._id,
      read: false,
      createdAt: new Date(now).toISOString(),
    });
    await ctx.db.insert("activityLog", {
      actorId: requester._id,
      actorName: requester.fullName,
      action: "opening_access_requested",
      entityType: "opening_access_request",
      entityId: id as string,
      metadata: { jobId: job._id, leadId: lead._id, reason: reason || null },
      occurredAt: new Date(now).toISOString(),
    });
    return { ok: true, id: id as string };
  },
});

export const decide = internalMutation({
  args: {
    actorId: v.string(),
    requestId: v.string(),
    approve: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const requestId = ctx.db.normalizeId("openingAccessRequests", args.requestId);
    const accessRequest = requestId ? await ctx.db.get(requestId) : null;
    if (!accessRequest) throw new Error("That access request no longer exists.");
    const actorRole = roleOf(actor);
    if (actorRole !== "admin" && (actorRole !== "ta_lead" || accessRequest.leadId !== actor._id)) {
      throw new Error("Only this opening's TA Lead can decide the request.");
    }
    if (accessRequest.status !== "pending") return { ok: true, status: accessRequest.status };

    const reason = args.reason?.trim() ?? "";
    if (!args.approve && !reason) throw new Error("Give a reason for rejecting the request.");
    if (reason.length > 1000) throw new Error("Keep the decision note under 1,000 characters.");

    const [job, requester] = await Promise.all([
      ctx.db.get(accessRequest.jobId),
      ctx.db.get(accessRequest.requesterId),
    ]);
    if (!job || !requestable(job)) throw new Error("That opening is no longer active.");
    if (!requester?.isActive || !["ta", "ta_support"].includes(roleOf(requester))) {
      throw new Error("That TA is no longer active.");
    }

    const now = Date.now();
    if (args.approve) {
      const existing = await ctx.db
        .query("jobAssignments")
        .withIndex("by_jobId_userId", (q) => q.eq("jobId", job._id).eq("userId", requester._id))
        .collect();
      const active = existing.find((row) => row.isActive);
      if (!active) {
        const reusable = existing[0];
        if (reusable) {
          await ctx.db.patch(reusable._id, {
            assignmentRole: "supporting_recruiter",
            assignedBy: actor._id,
            assignedAt: new Date(now).toISOString(),
            revokedAt: undefined,
            isActive: true,
            workingStage: "100%",
          });
        } else {
          await ctx.db.insert("jobAssignments", {
            jobId: job._id,
            userId: requester._id,
            assignmentRole: "supporting_recruiter",
            assignedBy: actor._id,
            assignedAt: new Date(now).toISOString(),
            isActive: true,
            workingStage: "100%",
          });
        }
      }
      const assignedTaIds = [...new Set([...(job.assignedTaIds ?? []), requester._id])];
      await ctx.db.patch(job._id, {
        assignedTaIds,
        assignedAt: job.assignedAt ?? now,
        updatedAt: new Date(now).toISOString(),
      });
    }

    const status = args.approve ? "approved" : "rejected";
    await ctx.db.patch(accessRequest._id, {
      status,
      decidedAt: now,
      decidedBy: actor._id,
      decisionReason: reason || undefined,
    });
    await ctx.db.insert("notifications", {
      userId: requester._id,
      type: args.approve ? "opening_access_approved" : "opening_access_rejected",
      title: args.approve ? "Opening access approved" : "Opening access declined",
      body: args.approve
        ? `${actor.fullName} approved your access to ${job.title}.`
        : `${actor.fullName} declined your access to ${job.title}: ${reason}`,
      jobId: job._id,
      read: false,
      createdAt: new Date(now).toISOString(),
    });
    await ctx.db.insert("activityLog", {
      actorId: actor._id,
      actorName: actor.fullName,
      action: args.approve ? "opening_access_approved" : "opening_access_rejected",
      entityType: "opening_access_request",
      entityId: accessRequest._id as string,
      metadata: {
        jobId: job._id,
        requesterId: requester._id,
        reason: reason || null,
        assignmentRole: args.approve ? "supporting_recruiter" : null,
      },
      occurredAt: new Date(now).toISOString(),
    });
    return { ok: true, status };
  },
});
