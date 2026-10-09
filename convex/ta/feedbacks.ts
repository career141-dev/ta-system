// convex/ta/feedbacks.ts
//
// TA Feedback & Approval System
//
// 1. TAs submit feedback / bug reports / feature requests from anywhere in the platform (status: "pending_lead").
// 2. TA Lead reviews submissions:
//    - "approved_for_admin": Endorsed and escalated to Admin queue.
//    - "resolved_by_lead": Resolved directly by Lead (e.g. process/training clarification).
//    - "declined_by_lead": Closed by Lead with feedback notes.
// 3. Admin acts on escalated items:
//    - "in_progress", "resolved", "declined_by_admin" with resolution notes.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireActor, optionalActor } from "./guard";

const CATEGORIES = v.union(
  v.literal("bug"),
  v.literal("feature_request"),
  v.literal("ui_issue"),
  v.literal("performance"),
  v.literal("workflow"),
  v.literal("other")
);

const PRIORITIES = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("urgent")
);

const STATUSES = v.union(
  v.literal("pending_lead"),
  v.literal("approved_for_admin"),
  v.literal("resolved_by_lead"),
  v.literal("declined_by_lead"),
  v.literal("in_progress"),
  v.literal("resolved"),
  v.literal("declined_by_admin")
);

function actorName(u: { fullName?: string; name?: string }): string {
  return u.fullName || u.name || "Anonymous";
}

function isLeadRole(role: string): boolean {
  return role === "ta_lead" || role === "director";
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "director";
}

export const submit = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    category: CATEGORIES,
    priority: PRIORITIES,
    title: v.string(),
    description: v.string(),
    pageUrl: v.string(),
    openingId: v.optional(v.string()),
    screenshot: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const now = Date.now();

    const db = ctx.db as any;
    const id = await db.insert("feedbacks", {
      submittedBy: actor._id as string,
      submittedByName: actorName(actor as { fullName?: string; name?: string }),
      submittedByRole: actor.role || "ta",
      createdAt: now,
      category: args.category,
      priority: args.priority,
      title: args.title.trim(),
      description: args.description.trim(),
      pageUrl: args.pageUrl,
      openingId: args.openingId,
      screenshot: args.screenshot,
      status: "pending_lead",
    });

    return { id: id as string };
  },
});

export const leadReview = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    feedbackId: v.string(),
    decision: v.union(
      v.literal("approved_for_admin"),
      v.literal("resolved_by_lead"),
      v.literal("declined_by_lead")
    ),
    leadNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const role = actor.role || "";
    if (!isLeadRole(role)) {
      throw new Error("Only TA Leads or Directors can review feedback submissions.");
    }

    const db = ctx.db as any;
    const fid = db.normalizeId("feedbacks", args.feedbackId);
    if (!fid) throw new Error("Feedback record not found");
    const existing = await db.get(fid);
    if (!existing) throw new Error("Feedback record not found");

    const now = Date.now();
    await db.patch(fid, {
      status: args.decision,
      leadReviewedBy: actor._id as string,
      leadReviewedByName: actorName(actor as { fullName?: string; name?: string }),
      leadReviewedAt: now,
      leadNotes: args.leadNotes?.trim() || undefined,
      resolvedAt: args.decision === "resolved_by_lead" ? now : undefined,
    });

    return { ok: true, status: args.decision };
  },
});

export const adminUpdate = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    feedbackId: v.string(),
    status: v.union(
      v.literal("in_progress"),
      v.literal("resolved"),
      v.literal("declined_by_admin")
    ),
    adminResolution: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const role = actor.role || "";
    if (!isAdminRole(role)) {
      throw new Error("Only Admins or Directors can update the admin feedback queue.");
    }

    const db = ctx.db as any;
    const fid = db.normalizeId("feedbacks", args.feedbackId);
    if (!fid) throw new Error("Feedback record not found");
    const existing = await db.get(fid);
    if (!existing) throw new Error("Feedback record not found");

    const now = Date.now();
    await db.patch(fid, {
      status: args.status,
      adminReviewedBy: actor._id as string,
      adminReviewedByName: actorName(actor as { fullName?: string; name?: string }),
      adminReviewedAt: now,
      adminResolution: args.adminResolution?.trim() || undefined,
      resolvedAt: args.status === "resolved" ? now : undefined,
    });

    return { ok: true, status: args.status };
  },
});

export const screenshotUrl = internalQuery({
  args: { storageId: v.string() },
  handler: async (ctx, args) => {
    const clean = args.storageId.replace(/^convex:/, "");
    if (!clean) return null;
    return await ctx.storage.getUrl(clean as never);
  },
});

export const listFeedbacks = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    status: v.optional(STATUSES),
  },
  handler: async (ctx, args) => {
    const actor = await optionalActor(ctx, args.actorId);
    if (!actor) return [];
    const role = actor.role || "ta";

    let rows: Record<string, any>[];
    if (args.status) {
      rows = (await (ctx.db as any)
        .query("feedbacks")
        .withIndex("by_status", (q: any) => q.eq("status", args.status!))
        .collect()) as Record<string, any>[];
    } else {
      rows = (await (ctx.db as any).query("feedbacks").collect()) as Record<string, any>[];
    }

    // Role filtering:
    // TA Leads and Directors see all feedback
    // Admins see only what a lead has approved (or their own submissions)
    // TAs see only their own submissions
    if (isLeadRole(role)) {
      // see all
    } else if (isAdminRole(role)) {
      rows = rows.filter(
        (r) =>
          r.status === "approved_for_admin" ||
          r.status === "in_progress" ||
          r.status === "resolved" ||
          r.status === "declined_by_admin" ||
          r.submittedBy === (actor._id as string)
      );
    } else {
      rows = rows.filter((r) => r.submittedBy === (actor._id as string));
    }

    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows.map((r) => ({
      id: r._id as string,
      submittedBy: r.submittedBy,
      submittedByName: r.submittedByName,
      submittedByRole: r.submittedByRole,
      createdAt: r.createdAt,
      category: r.category,
      priority: r.priority,
      title: r.title,
      description: r.description,
      pageUrl: r.pageUrl,
      openingId: r.openingId,
      screenshot: r.screenshot,
      status: r.status,
      leadReviewedBy: r.leadReviewedBy,
      leadReviewedByName: r.leadReviewedByName,
      leadReviewedAt: r.leadReviewedAt,
      leadNotes: r.leadNotes,
      adminReviewedBy: r.adminReviewedBy,
      adminReviewedByName: r.adminReviewedByName,
      adminReviewedAt: r.adminReviewedAt,
      adminResolution: r.adminResolution,
      resolvedAt: r.resolvedAt,
    }));
  },
});
