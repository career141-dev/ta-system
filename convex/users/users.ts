// convex/users.ts
import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireRole } from "../lib/permissions";

function formatNameFromEmail(email?: string): string {
  if (!email || !email.includes("@")) return "Team Member";
  const prefix = email.split("@")[0];
  const parts = prefix.split(/[._-]/).filter(Boolean);
  if (parts.length === 0) return "Team Member";
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

// Called from Next.js on every login via useConvexAuth / onAuthStateChange
export const syncCurrentUser = mutation({
  args: { 
    name: v.string(), 
    email: v.string(), 
    avatarUrl: v.optional(v.string()),
    invitedRole: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    let fullName = args.name;
    if (!fullName || fullName.trim() === "" || fullName === "Unknown User") {
      fullName = formatNameFromEmail(args.email);
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    const isSuperAdminEmail = 
      args.email.toLowerCase() === "sanjaysanjeev2000@gmail.com" ||
      args.email.toLowerCase() === "bytecreator3@gmail.com" ||
      args.email.toLowerCase() === "sanjeevsivasuthakaran@gmail.com";

    if (existing) {
      // Update login time and name/email if changed — DO NOT overwrite existing user role!
      const patchData: any = {
        email: args.email,
        avatarUrl: args.avatarUrl,
        lastLoginAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!existing.fullName || existing.fullName === "Unknown User" || args.name !== "Unknown User") {
        patchData.fullName = fullName;
      }
      await ctx.db.patch(existing._id, patchData);
      return existing._id;
    }

    // First login — assign the invited role if it exists, otherwise default to admin for super-admins or viewer
    const roleToAssign = isSuperAdminEmail ? "admin" : (args.invitedRole || "viewer");
    const isOnboarded = isSuperAdminEmail || !!args.invitedRole;

    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      clerkUserId: identity.subject,
      fullName: fullName,
      email: args.email,
      avatarUrl: args.avatarUrl,
      role: roleToAssign as any,
      isActive: true,
      isOnboarded: isOnboarded,
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
});

// Admin / TA Manager — assign role to a user
export const assignRole = mutation({
  args: { targetUserId: v.id("users"), newRole: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, ["admin"]);
    const target = await ctx.db.get(args.targetUserId);
    if (!target) throw new Error("Target user not found");
    const fromRole = target.role;

    // Update role and mark as onboarded if they were pending
    await ctx.db.patch(args.targetUserId, {
      role: args.newRole as any,
      isOnboarded: true,
      updatedAt: new Date().toISOString(),
    });

    // Write to audit log
    await ctx.db.insert("roleAuditLog", {
      targetUserId: args.targetUserId,
      changedBy: admin._id,
      fromRole,
      toRole: args.newRole,
      reason: args.reason,
      occurredAt: new Date().toISOString(),
    });
  },
});

// Admin / TA Manager — update team member name / email
export const updateUser = mutation({
  args: {
    targetUserId: v.id("users"),
    fullName: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, ["admin", "ta_manager"]);
    const target = await ctx.db.get(args.targetUserId);
    if (!target) throw new Error("Target user not found");

    await ctx.db.patch(args.targetUserId, {
      fullName: args.fullName.trim(),
      ...(args.email ? { email: args.email.trim() } : {}),
      updatedAt: new Date().toISOString(),
    });
  },
});

export const deactivate = mutation({
  args: { targetUserId: v.id("users"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, ["admin"]);
    
    await ctx.db.patch(args.targetUserId, {
      isActive: false,
      updatedAt: new Date().toISOString(),
    });

    await ctx.db.insert("roleAuditLog", {
      targetUserId: args.targetUserId,
      changedBy: admin._id,
      fromRole: "active",
      toRole: "deactivated",
      reason: args.reason,
      occurredAt: new Date().toISOString(),
    });
  },
});

export const activate = mutation({
  args: { targetUserId: v.id("users"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, ["admin"]);
    
    await ctx.db.patch(args.targetUserId, {
      isActive: true,
      updatedAt: new Date().toISOString(),
    });

    await ctx.db.insert("roleAuditLog", {
      targetUserId: args.targetUserId,
      changedBy: admin._id,
      fromRole: "deactivated",
      toRole: "active",
      reason: args.reason,
      occurredAt: new Date().toISOString(),
    });
  },
});


export const getTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.map((u) => {
      let displayName = u.fullName;
      if (!displayName || displayName.trim() === "" || displayName === "Unknown User") {
        displayName = formatNameFromEmail(u.email);
      }
      return {
        ...u,
        fullName: displayName,
        rawFullName: u.fullName,
        jobCount: 0,
      };
    });
  },
});

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (user && (!user.fullName || user.fullName === "Unknown User")) {
      return {
        ...user,
        fullName: formatNameFromEmail(user.email),
      };
    }

    return user;
  },
});

export const listByRoles = query({
  args: { roles: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userGroups = await Promise.all(
      args.roles.map(role => 
        ctx.db.query("users").withIndex("by_role", q => q.eq("role", role as any)).collect()
      )
    );
    return userGroups.flat().map((u) => ({
      ...u,
      fullName: (!u.fullName || u.fullName === "Unknown User") ? formatNameFromEmail(u.email) : u.fullName,
    }));
  },
});

export const getAllUsers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.map((u) => ({
      ...u,
      fullName: (!u.fullName || u.fullName === "Unknown User") ? formatNameFromEmail(u.email) : u.fullName,
    }));
  }
});

export const fixAllUserRolesToAdmin = mutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    for (const u of users) {
      await ctx.db.patch(u._id, {
        role: "admin",
        isActive: true,
        isOnboarded: true,
        updatedAt: new Date().toISOString(),
      });
    }
    return { success: true, count: users.length };
  },
});

export const setUserRoleByEmail = mutation({
  args: { email: v.string(), role: v.string() },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const target = users.find((u) => u.email.toLowerCase() === args.email.toLowerCase());
    if (target) {
      await ctx.db.patch(target._id, {
        role: args.role as any,
        updatedAt: new Date().toISOString(),
      });
      return { success: true, email: args.email, newRole: args.role };
    }
    return { success: false, error: "User not found" };
  },
});

