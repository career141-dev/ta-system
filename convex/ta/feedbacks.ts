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
import { deskRole, isAdminRole, isLeadRole, maySee } from "../lib/feedbackAccess";

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

    const role = deskRole(actor);
    const isLeadOrAdmin = isLeadRole(role) || isAdminRole(role);
    const status = isLeadOrAdmin ? "approved_for_admin" : "pending_lead";

    const db = ctx.db as any;
    const id = await db.insert("feedbacks", {
      submittedBy: actor._id as string,
      submittedByName: actorName(actor as { fullName?: string; name?: string }),
      submittedByRole: role,
      createdAt: now,
      category: args.category,
      priority: args.priority,
      title: args.title.trim(),
      description: args.description.trim(),
      pageUrl: args.pageUrl,
      openingId: args.openingId,
      screenshot: args.screenshot,
      status,
      ...(isLeadOrAdmin
        ? {
            leadReviewedBy: actor._id as string,
            leadReviewedByName: actorName(actor as { fullName?: string; name?: string }),
            leadReviewedAt: now,
            leadNotes: `Submitted directly by ${role === "admin" ? "Admin" : role === "director" ? "Director" : "TA Lead"}`,
          }
        : {}),
    });

    return { id: id as string, status };
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
    const role = deskRole(actor);
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
    const role = deskRole(actor);
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

/**
 * The screenshot of one feedback item, for someone allowed to see that item.
 * It took a bare storage id and asked nobody before (review of #157, 9 Oct):
 * any signed-in account, a client's included, could have fetched any file in
 * storage — CVs among them — by its id. Now it is the item's own screenshot,
 * or nothing.
 */
export const screenshotUrl = internalQuery({
  args: { actorId: v.string(), feedbackId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const id = ctx.db.normalizeId("feedbacks", args.feedbackId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || !maySee(actor, row) || !row.screenshot) return null;
    const clean = row.screenshot.replace(/^convex:/, "");
    if (!clean || clean.startsWith("data:")) return null;
    // The id is whatever the browser sent with the feedback, so it could name a
    // CV. Only an image is ever served as a screenshot.
    const fileId = ctx.db.system.normalizeId("_storage", clean);
    const meta = fileId ? await ctx.db.system.get(fileId) : null;
    if (!meta || !(meta.contentType ?? "").startsWith("image/")) return null;
    return await ctx.storage.getUrl(fileId!);
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

    let rows: Record<string, any>[];
    if (args.status) {
      rows = (await (ctx.db as any)
        .query("feedbacks")
        .withIndex("by_status", (q: any) => q.eq("status", args.status!))
        .collect()) as Record<string, any>[];
    } else {
      rows = (await (ctx.db as any).query("feedbacks").collect()) as Record<string, any>[];
    }

    // Leads and directors see all; admins what a lead sent on, and their own;
    // everyone else only their own (maySee, shared with the screenshot).
    rows = rows.filter((r) => maySee(actor, r as { submittedBy: string; status: string }));

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
