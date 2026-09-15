import { v } from "convex/values";
import { query, mutation, internalQuery } from "../_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("whatsappNumbers").collect();
  },
});

export const isTaNumber = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const cleanPhone = args.phone.startsWith('+') ? args.phone : `+${args.phone.replace(/[^0-9]/g, '')}`;
    const existing = await ctx.db
      .query("whatsappNumbers")
      .withIndex("by_phone", (q) => q.eq("phone", cleanPhone))
      .first();
    return !!existing;
  }
});

export const add = mutation({
  args: {
    name: v.string(),
    phone: v.string(),
    whatchimpPhoneId: v.string(),
    wabaId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Basic formatting for phone
    const cleanPhone = args.phone.startsWith('+') ? args.phone : `+${args.phone.replace(/[^0-9]/g, '')}`;
    
    // Check if it already exists
    const existing = await ctx.db
      .query("whatsappNumbers")
      .withIndex("by_phone", (q) => q.eq("phone", cleanPhone))
      .first();

    if (existing) {
      throw new Error("This WhatsApp number is already registered.");
    }

    return await ctx.db.insert("whatsappNumbers", {
      name: args.name,
      phone: cleanPhone,
      whatchimpPhoneId: args.whatchimpPhoneId,
      wabaId: args.wabaId,
      createdAt: new Date().toISOString(),
    });
  },
});

export const remove = mutation({
  args: {
    id: v.id("whatsappNumbers"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const removeNumberByPattern = mutation({
  args: { pattern: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("whatsappNumbers").collect();
    let removed = 0;
    for (const num of all) {
      if (
        num.phone.includes(args.pattern) ||
        num.whatchimpPhoneId.includes(args.pattern) ||
        num.name.toLowerCase().includes(args.pattern.toLowerCase())
      ) {
        await ctx.db.delete(num._id);
        removed++;
      }
    }
    return { removed };
  },
});

