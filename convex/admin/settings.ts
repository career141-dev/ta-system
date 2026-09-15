import { query, mutation, internalQuery, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { requireRole } from "../lib/permissions";
import { internal } from "../_generated/api";

export const getSystemSettings = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["admin", "ta_manager"]);
    
    const configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
    
    return configRow?.channel_toggles || {
      whatsappIngestion: true,
      emailIngestion: true,
      whatsappFollowUp: true,
      emailFollowUp: true,
    };
  }
});

export const getInternalSystemSettings = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
  }
});

export const updateChannelToggles = mutation({
  args: {
    toggles: v.object({
      whatsappIngestion: v.boolean(),
      emailIngestion: v.boolean(),
      whatsappFollowUp: v.boolean(),
      emailFollowUp: v.boolean(),
    })
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, ["admin", "ta_manager"]);
    
    let configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
    
    const oldToggles: any = configRow?.channel_toggles || {};
    
    if (configRow) {
      await ctx.db.patch(configRow._id, {
        channel_toggles: args.toggles,
        updatedBy: user._id,
        updatedAt: new Date().toISOString()
      });
    } else {
      await ctx.db.insert("appSettings", {
        key: "system",
        channel_toggles: args.toggles,
        updatedBy: user._id,
        updatedAt: new Date().toISOString()
      });
    }

    // Auto-resume logic:
    // If whatsappIngestion changed from false to true, resume whatsapp
    if (oldToggles.whatsappIngestion === false && args.toggles.whatsappIngestion === true) {
      await ctx.scheduler.runAfter(0, internal.cvs.ingestion.resumePausedUploads, { channel: "whatsapp" });
    }
    // If emailIngestion changed from false to true, resume email
    return { success: true };
  }
});

export const setSystemTestSettings = internalMutation({
  args: {
    testModeEnabled: v.optional(v.boolean()),
    testPhoneNumber: v.optional(v.string()),
    testEmailAddress: v.optional(v.string()),
    channel_toggles: v.optional(v.object({
      whatsappIngestion: v.boolean(),
      emailIngestion: v.boolean(),
      whatsappFollowUp: v.boolean(),
      emailFollowUp: v.boolean(),
    })),
  },
  handler: async (ctx, args) => {
    let configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
    if (configRow) {
      await ctx.db.patch(configRow._id, {
        ...(args.testModeEnabled !== undefined ? { testModeEnabled: args.testModeEnabled } : {}),
        ...(args.testPhoneNumber !== undefined ? { testPhoneNumber: args.testPhoneNumber } : {}),
        ...(args.testEmailAddress !== undefined ? { testEmailAddress: args.testEmailAddress } : {}),
        ...(args.channel_toggles !== undefined ? { channel_toggles: args.channel_toggles } : {}),
        updatedAt: new Date().toISOString(),
      });
    } else {
      await ctx.db.insert("appSettings", {
        key: "system",
        testModeEnabled: args.testModeEnabled ?? true,
        testPhoneNumber: args.testPhoneNumber,
        testEmailAddress: args.testEmailAddress,
        channel_toggles: args.channel_toggles,
        updatedAt: new Date().toISOString(),
      });
    }
  },
});

