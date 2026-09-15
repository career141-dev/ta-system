import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireUser } from "../lib/permissions";

export const getTemplates = query({
  args: {
    type: v.optional(v.union(v.literal("initial_outreach"), v.literal("sample_follow_up"), v.literal("general"))),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!user) return [];
    const userId = user._id;
    if (!userId) return [];

    let allTemplates = await ctx.db.query("messageTemplates")
      .filter(q => q.eq(q.field("isActive"), true))
      .collect();

    // Filter by type if provided
    if (args.type) {
      allTemplates = allTemplates.filter(t => t.type === args.type);
    }

    // Filter to only show global templates or templates created by this user
    return allTemplates.filter(t => t.isGlobal || t.createdBy === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

export const createTemplate = mutation({
  args: {
    name: v.string(),
    type: v.union(v.literal("initial_outreach"), v.literal("sample_follow_up"), v.literal("general")),
    content: v.string(),
    isGlobal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!user) throw new Error("Unauthorized");
    const userId = user._id;

    // Only admins can create global templates
    const isGlobal = args.isGlobal && user.role === "admin" ? true : false;

    return await ctx.db.insert("messageTemplates", {
      name: args.name,
      type: args.type,
      content: args.content,
      createdBy: userId,
      isGlobal,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
  },
});

export const updateTemplate = mutation({
  args: {
    id: v.id("messageTemplates"),
    name: v.optional(v.string()),
    type: v.optional(v.union(v.literal("initial_outreach"), v.literal("sample_follow_up"), v.literal("general"))),
    content: v.optional(v.string()),
    isGlobal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!user) throw new Error("Unauthorized");
    const userId = user._id;

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Template not found");

    // Only creator or admin can update
    if (existing.createdBy !== userId && user.role !== "admin") {
      throw new Error("Unauthorized to edit this template");
    }

    const updates: any = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.type !== undefined) updates.type = args.type;
    if (args.content !== undefined) updates.content = args.content;
    if (args.isGlobal !== undefined && user.role === "admin") updates.isGlobal = args.isGlobal;

    await ctx.db.patch(args.id, updates);
  },
});

export const deleteTemplate = mutation({
  args: {
    id: v.id("messageTemplates"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!user) throw new Error("Unauthorized");
    const userId = user._id;

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Template not found");

    // Only creator or admin can delete
    if (existing.createdBy !== userId && user.role !== "admin") {
      throw new Error("Unauthorized to delete this template");
    }

    // Soft delete
    await ctx.db.patch(args.id, {
      isActive: false,
      updatedAt: new Date().toISOString(),
    });
  },
});
