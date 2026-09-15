import { v } from "convex/values";
import { mutation, query, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireUser } from "../lib/permissions";

/**
 * List candidate inquiries with database indexing & safety limit cap (max 100 items per batch).
 * Prevents full-table memory scans to guarantee high performance & server stability.
 */
export const listInquiries = query({
  args: {
    channel: v.optional(v.union(v.literal("all"), v.literal("whatsapp"), v.literal("email"))),
    status: v.optional(v.union(v.literal("all"), v.literal("unresolved"), v.literal("answered_by_ai"), v.literal("resolved_by_ta"))),
    jobId: v.optional(v.id("jobs")),
    importanceLevel: v.optional(v.union(v.literal("all"), v.literal("high"), v.literal("medium"), v.literal("low"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxTake = Math.min(args.limit || 50, 100);
    let inquiries: any[] = [];

    // Use specific database index if filtered by channel or status
    if (args.channel && args.channel !== "all") {
      inquiries = await ctx.db
        .query("candidateInquiries")
        .withIndex("by_channel", (q) => q.eq("channel", args.channel as any))
        .order("desc")
        .take(maxTake);
    } else if (args.status && args.status !== "all") {
      inquiries = await ctx.db
        .query("candidateInquiries")
        .withIndex("by_status", (q) => q.eq("status", args.status as any))
        .order("desc")
        .take(maxTake);
    } else if (args.importanceLevel && args.importanceLevel !== "all") {
      inquiries = await ctx.db
        .query("candidateInquiries")
        .withIndex("by_importance", (q) => q.eq("importanceLevel", args.importanceLevel as any))
        .order("desc")
        .take(maxTake);
    } else if (args.jobId) {
      inquiries = await ctx.db
        .query("candidateInquiries")
        .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId!))
        .order("desc")
        .take(maxTake);
    } else {
      inquiries = await ctx.db
        .query("candidateInquiries")
        .order("desc")
        .take(maxTake);
    }

    // Apply remaining filters in-memory on the bounded result set
    if (args.channel && args.channel !== "all") {
      inquiries = inquiries.filter((i) => i.channel === args.channel);
    }
    if (args.status && args.status !== "all") {
      inquiries = inquiries.filter((i) => i.status === args.status);
    }
    if (args.jobId) {
      inquiries = inquiries.filter((i) => i.jobId === args.jobId);
    }
    if (args.importanceLevel && args.importanceLevel !== "all") {
      inquiries = inquiries.filter((i) => i.importanceLevel === args.importanceLevel);
    }

    // Enrich with Candidate and Job details safely
    const enriched = await Promise.all(
      inquiries.map(async (inq) => {
        const candidate = inq.candidateId ? (await ctx.db.get(inq.candidateId)) as any : null;
        const job = inq.jobId ? (await ctx.db.get(inq.jobId)) as any : null;
        return {
          ...inq,
          candidateName: candidate?.fullName || "Unknown Candidate",
          candidateEmail: candidate?.email,
          candidatePhone: candidate?.phone,
          jobTitle: job?.title || "General Application",
        };
      })
    );

    return enriched;
  },
});

/**
 * Bounded summary metrics for inquiries top-level cards (uses indexed queries).
 */
export const getInquirySummaryStats = query({
  args: {},
  handler: async (ctx) => {
    // Bounded queries using status index (max 500 records) to protect server performance
    const unresolved = await ctx.db
      .query("candidateInquiries")
      .withIndex("by_status", (q) => q.eq("status", "unresolved"))
      .take(500);

    const unresolvedWhatsApp = unresolved.filter((i) => i.channel === "whatsapp").length;
    const unresolvedEmail = unresolved.filter((i) => i.channel === "email").length;
    const highImportance = unresolved.filter((i) => i.importanceLevel === "high").length;

    return {
      totalInquiries: unresolved.length,
      unresolvedCount: unresolved.length,
      unresolvedWhatsApp,
      unresolvedEmail,
      highImportanceCount: highImportance,
    };
  },
});

/**
 * Internal mutation to record a candidate inquiry safely.
 */
export const createInquiry = internalMutation({
  args: {
    candidateId: v.id("candidates"),
    applicationId: v.optional(v.id("applications")),
    jobId: v.optional(v.id("jobs")),
    communicationId: v.optional(v.id("communications")),
    channel: v.union(v.literal("whatsapp"), v.literal("email")),
    questionText: v.string(),
    category: v.union(
      v.literal("salary_compensation"),
      v.literal("visa_sponsorship"),
      v.literal("location_remote"),
      v.literal("notice_start_date"),
      v.literal("tech_stack"),
      v.literal("client_details"),
      v.literal("general_inquiry")
    ),
    importanceLevel: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    aiAutoReplyText: v.optional(v.string()),
    status: v.optional(v.union(v.literal("unresolved"), v.literal("answered_by_ai"), v.literal("resolved_by_ta"))),
  },
  handler: async (ctx, args) => {
    const qText = (args.questionText || "").trim();
    const isHtmlPayload =
      qText.startsWith("<html") ||
      qText.startsWith("<!DOCTYPE") ||
      qText.includes("<head>") ||
      qText.includes("data-email-preheader") ||
      qText.includes("mercado-container") ||
      qText.includes("<div") ||
      qText.includes("<table") ||
      qText.includes("Linkedin@career141.com") ||
      qText.includes("linkedin@career141.com") ||
      qText.includes("Your job has a new applicant") ||
      qText.includes("Your new applicant meets your job targeting criteria");

    if (isHtmlPayload) {
      console.log(`[Inquiries] Rejecting raw HTML payload inquiry insertion`);
      return null;
    }

    // Deduplication check: bounded lookup on candidateId index (take 20)
    const existing = await ctx.db
      .query("candidateInquiries")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .take(20);

    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const duplicate = existing.find(
      (i) => i.createdAt > tenMinAgo && i.questionText.trim().toLowerCase() === args.questionText.trim().toLowerCase()
    );

    if (duplicate) {
      console.log(`[Inquiries] Skipping duplicate inquiry insertion for candidate ${args.candidateId}`);
      return duplicate._id;
    }

    const inquiryId = await ctx.db.insert("candidateInquiries", {
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      communicationId: args.communicationId,
      channel: args.channel,
      questionText: args.questionText,
      category: args.category,
      importanceLevel: args.importanceLevel,
      status: args.status || "unresolved",
      aiAutoReplyText: args.aiAutoReplyText,
      createdAt: Date.now(),
    });

    console.log(`[Inquiries] Recorded new candidate inquiry (${args.category}, ${args.importanceLevel}) from ${args.channel}`);
    return inquiryId;
  },
});

/**
 * TA Action: Resolve inquiry via WhatsApp reply.
 */
export const resolveInquiryViaWhatsApp = mutation({
  args: {
    inquiryId: v.id("candidateInquiries"),
    responseText: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) throw new Error("Inquiry not found");

    const now = Date.now();
    await ctx.db.patch(args.inquiryId, {
      status: "resolved_by_ta",
      taResponseText: args.responseText,
      resolvedByUserId: user._id,
      resolvedAt: now,
    });

    // Record outbound communication
    const commId = await ctx.db.insert("communications", {
      candidateId: inquiry.candidateId,
      applicationId: inquiry.applicationId,
      jobId: inquiry.jobId,
      direction: "outbound",
      channel: "whatsapp",
      body: args.responseText,
      deliveryStatus: "pending",
      sentAt: now,
      senderAgent: "system",
      stoppedSequence: false,
    });

    // Schedule WhatsApp dispatch via WhatChimp
    if (inquiry.jobId) {
      await ctx.scheduler.runAfter(0, internal.communications.whatsappOutbound.sendWhatsApp, {
        communicationId: commId,
        candidateId: inquiry.candidateId,
        jobId: inquiry.jobId,
        body: args.responseText,
      });
    }

    return { success: true };
  },
});

/**
 * TA Action: Resolve inquiry via Email reply.
 */
export const resolveInquiryViaEmail = mutation({
  args: {
    inquiryId: v.id("candidateInquiries"),
    subject: v.string(),
    responseText: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) throw new Error("Inquiry not found");

    const candidate = await ctx.db.get(inquiry.candidateId);
    if (!candidate || !candidate.email) throw new Error("Candidate email address not found");

    const now = Date.now();
    await ctx.db.patch(args.inquiryId, {
      status: "resolved_by_ta",
      taResponseText: args.responseText,
      resolvedByUserId: user._id,
      resolvedAt: now,
    });

    // Insert communication record
    const emailCommId = await ctx.db.insert("communications", {
      candidateId: inquiry.candidateId,
      jobId: inquiry.jobId,
      applicationId: inquiry.applicationId,
      direction: "outbound",
      channel: "email",
      subject: args.subject,
      body: args.responseText,
      deliveryStatus: "pending",
      sentAt: now,
      stoppedSequence: false,
    });

    // Dispatch via MS Graph Email
    const taEmail = user.email || "ta@career141.com";
    const htmlBody = args.responseText.replace(/\n/g, "<br>");
    await ctx.scheduler.runAfter(0, internal.communications.graphEmail.sendGraphEmail, {
      communicationId: emailCommId,
      candidateJobId: inquiry.applicationId as string,
      taEmail,
      toAddress: candidate.email,
      subject: args.subject,
      bodyHtml: htmlBody,
    });

    return { success: true };
  },
});

/**
 * TA Action: Mark inquiry as resolved without sending outbound reply.
 */
export const dismissInquiry = mutation({
  args: {
    inquiryId: v.id("candidateInquiries"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry) throw new Error("Inquiry not found");

    await ctx.db.patch(args.inquiryId, {
      status: "resolved_by_ta",
      taResponseText: args.note || "Dismissed by TA",
      resolvedByUserId: user._id,
      resolvedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Cleanup Mutation: Purge invalid raw HTML inquiries created by naive email URL query string matching.
 */
export const purgeInvalidHtmlInquiries = mutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.batchSize || 30;
    const inquiries = await ctx.db.query("candidateInquiries").take(limit);
    let deletedCount = 0;
    for (const inq of inquiries) {
      const qText = (inq.questionText || "").trim();
      const isHtmlPayload =
        qText.startsWith("<html") ||
        qText.startsWith("<!DOCTYPE") ||
        qText.includes("<head>") ||
        qText.includes("data-email-preheader") ||
        qText.includes("mercado-container") ||
        qText.includes("<div") ||
        qText.includes("<table");

      if (isHtmlPayload) {
        await ctx.db.delete(inq._id);
        deletedCount++;
      }
    }
    return {
      success: true,
      evaluated: inquiries.length,
      deletedCount,
      hasMore: inquiries.length >= limit,
    };
  },
});

