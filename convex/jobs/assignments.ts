import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireRole, requireUser, requireJobAssignment } from "../lib/permissions";

// Helper: Check if user is the Primary Recruiter for a job
async function isPrimaryRecruiter(ctx: any, jobId: string, userId: string) {
  const assignment = await ctx.db.query("jobAssignments")
    .withIndex("by_jobId", (q: any) => q.eq("jobId", jobId))
    .filter((q: any) => q.eq(q.field("assignmentRole"), "primary_recruiter"))
    .filter((q: any) => q.eq(q.field("isActive"), true))
    .filter((q: any) => q.eq(q.field("userId"), userId))
    .first();
  return !!assignment;
}

export const changePrimaryRecruiter = mutation({
  args: { jobId: v.id("jobs"), newUserId: v.id("users") },
  handler: async (ctx, { jobId, newUserId }) => {
    const user = await requireRole(ctx, ["admin", "ta_manager"]);

    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job not found");

    const now = new Date().toISOString();

    // Revoke old primary recruiter
    const oldAssignments = await ctx.db.query("jobAssignments")
      .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
      .filter((q) => q.eq(q.field("assignmentRole"), "primary_recruiter"))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    for (const assignment of oldAssignments) {
      await ctx.db.patch(assignment._id, {
        isActive: false,
        revokedAt: now,
      });
    }

    // Insert new assignment
    await ctx.db.insert("jobAssignments", {
      jobId,
      userId: newUserId,
      assignmentRole: "primary_recruiter",
      assignedBy: user._id,
      assignedAt: now,
      isActive: true,
    });

    // Update job record
    await ctx.db.patch(jobId, { primaryRecruiterId: newUserId });

    return { success: true };
  },
});

export const addSupportingRecruiter = mutation({
  args: { jobId: v.id("jobs"), newUserId: v.id("users") },
  handler: async (ctx, { jobId, newUserId }) => {
    const user = await requireUser(ctx);
    const isPrimary = await isPrimaryRecruiter(ctx, jobId, user._id);
    
    // Allowed: admin, ta_manager, primary_recruiter
    if (!["admin", "ta_manager"].includes(user.role) && !isPrimary) {
      throw new Error("Unauthorized to add Supporting Recruiter");
    }

    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job not found");

    const now = new Date().toISOString();

    await ctx.db.insert("jobAssignments", {
      jobId,
      userId: newUserId,
      assignmentRole: "supporting_recruiter",
      assignedBy: user._id,
      assignedAt: now,
      isActive: true,
    });

    // Update job record array
    const current = job.supportingRecruiterIds || [];
    if (!current.includes(newUserId)) {
      await ctx.db.patch(jobId, { supportingRecruiterIds: [...current, newUserId] });
    }

    return { success: true };
  },
});

export const removeSupportingRecruiter = mutation({
  args: { jobId: v.id("jobs"), removeUserId: v.id("users") },
  handler: async (ctx, { jobId, removeUserId }) => {
    const user = await requireUser(ctx);
    const isPrimary = await isPrimaryRecruiter(ctx, jobId, user._id);
    
    // Allowed: admin, ta_manager, primary_recruiter
    if (!["admin", "ta_manager"].includes(user.role) && !isPrimary) {
      throw new Error("Unauthorized to remove Supporting Recruiter");
    }

    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job not found");

    const now = new Date().toISOString();

    const assignments = await ctx.db.query("jobAssignments")
      .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
      .filter((q) => q.eq(q.field("assignmentRole"), "supporting_recruiter"))
      .filter((q) => q.eq(q.field("userId"), removeUserId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    for (const assignment of assignments) {
      await ctx.db.patch(assignment._id, {
        isActive: false,
        revokedAt: now,
      });
    }

    // Update job record array
    const current = job.supportingRecruiterIds || [];
    const updated = current.filter(id => id !== removeUserId);
    await ctx.db.patch(jobId, { supportingRecruiterIds: updated });

    return { success: true };
  },
});

export const changeDirector = mutation({
  args: { jobId: v.id("jobs"), newDirectorId: v.optional(v.id("users")) },
  handler: async (ctx, { jobId, newDirectorId }) => {
    const user = await requireRole(ctx, ["admin", "ta_manager"]);

    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job not found");

    const now = new Date().toISOString();

    const oldAssignments = await ctx.db.query("jobAssignments")
      .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
      .filter((q) => q.eq(q.field("assignmentRole"), "director"))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    for (const assignment of oldAssignments) {
      await ctx.db.patch(assignment._id, {
        isActive: false,
        revokedAt: now,
      });
    }

    if (newDirectorId) {
      await ctx.db.insert("jobAssignments", {
        jobId,
        userId: newDirectorId,
        assignmentRole: "director",
        assignedBy: user._id,
        assignedAt: now,
        isActive: true,
      });
      await ctx.db.patch(jobId, { directorId: newDirectorId });
    } else {
      await ctx.db.patch(jobId, { directorId: undefined });
    }

    return { success: true };
  },
});

export const changeClientContact = mutation({
  args: { jobId: v.id("jobs"), clientName: v.optional(v.string()), clientEmail: v.optional(v.string()) },
  handler: async (ctx, { jobId, clientName, clientEmail }) => {
    const user = await requireRole(ctx, ["admin", "ta_manager", "senior_ta"]);

    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job not found");

    // We don't have a specific user ID for client yet since they are external until portal invite
    // Just update the jobs table. Future logic handles portal invite.
    await ctx.db.patch(jobId, { 
      clientContactName: clientName,
      clientContactEmail: clientEmail
    });

    return { success: true };
  },
});
