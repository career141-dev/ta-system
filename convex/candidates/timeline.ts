import { query } from "../_generated/server";
import { v } from "convex/values";

export const getTimeline = query({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const application = await ctx.db.get(args.applicationId);
    if (!application) {
      throw new Error("Application not found");
    }

    const events: any[] = [];

    // 1. Application Created Event
    const appCreatedAt = typeof application.createdAt === "string" 
      ? new Date(application.createdAt).getTime() 
      : application.createdAt;
      
    events.push({
      id: `app_created_${application._id}`,
      type: "application_created",
      timestamp: appCreatedAt,
      title: "Application Created",
      description: `Source: ${application.sourceChannel}`,
    });

    // 2. Pipeline Events (Stage Changes & System Actions)
    const pipelineEvents = await ctx.db
      .query("pipelineEvents")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    for (const pe of pipelineEvents) {
      let title = "Pipeline Event";
      let description = pe.notes || pe.note || "";
      
      if (pe.eventType === "stage_change") {
        const formatStage = (s: string) => s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        title = `Moved to ${pe.toStage ? formatStage(pe.toStage) : 'Unknown'}`;
        if (pe.fromStage) {
          description = `Moved from ${formatStage(pe.fromStage)} by ${pe.actorType}`;
        }
      } else if (pe.eventType === "note_added") {
        title = "Note Added";
      }

      events.push({
        id: pe._id,
        type: pe.eventType === "stage_change" ? "stage_change" : "note",
        timestamp: pe.createdAt,
        title,
        description,
        metadata: {
          actorName: pe.actorName,
          actorType: pe.actorType,
        }
      });
    }

    // 3. Communications (Messages Sent/Received)
    const communications = await ctx.db
      .query("communications")
      .withIndex("by_applicationId", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    for (const comm of communications) {
      const commSentAt = typeof comm.sentAt === "string" 
        ? new Date(comm.sentAt).getTime() 
        : comm.sentAt;

      let title = "";
      if (comm.direction === "outbound") {
        title = `Sent ${comm.channel} message`;
        if (comm.senderAgent) title += ` (via ${comm.senderAgent})`;
      } else {
        title = `Received ${comm.channel} reply`;
      }

      events.push({
        id: comm._id,
        type: "communication",
        timestamp: commSentAt,
        title,
        description: comm.body || comm.subject || "",
        metadata: {
          direction: comm.direction,
          channel: comm.channel,
          status: comm.deliveryStatus || comm.status,
          openedAt: comm.openedAt,
          repliedAt: comm.repliedAt,
        }
      });
    }

    // 4. Candidate Inquiries & Questions
    const inquiries = await ctx.db
      .query("candidateInquiries")
      .withIndex("by_applicationId", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    for (const inq of inquiries) {
      const categoryLabels: Record<string, string> = {
        salary_compensation: "Salary / Compensation",
        visa_sponsorship: "Visa / Sponsorship",
        location_remote: "Location / Remote Work",
        notice_start_date: "Notice Period / Start Date",
        tech_stack: "Tech Stack",
        client_details: "Client Details",
        general_inquiry: "General Question",
      };

      events.push({
        id: `inquiry_${inq._id}`,
        type: "candidate_inquiry",
        timestamp: inq.createdAt,
        title: `Candidate Question (${inq.channel === "whatsapp" ? "WhatsApp" : "Email"})`,
        description: inq.questionText,
        metadata: {
          inquiryId: inq._id,
          channel: inq.channel,
          category: inq.category,
          categoryLabel: categoryLabels[inq.category] || "Question",
          importanceLevel: inq.importanceLevel,
          status: inq.status,
          aiAutoReplyText: inq.aiAutoReplyText,
          taResponseText: inq.taResponseText,
          resolvedAt: inq.resolvedAt,
        },
      });
    }

    // Sort descending (newest first)
    events.sort((a, b) => b.timestamp - a.timestamp);

    const job = await ctx.db.get(application.jobId);
    const candidate = await ctx.db.get(application.candidateId);

    return {
      events,
      applicationInfo: {
        currentStage: application.currentStage,
        lastStageChangedAt: typeof application.lastStageChangedAt === 'string' 
          ? new Date(application.lastStageChangedAt).getTime() 
          : application.lastStageChangedAt,
        followUpCvReceived: application.followUpCvReceived,
        followUpCurrentSalary: application.followUpCurrentSalary,
        followUpExpectedSalary: application.followUpExpectedSalary,
        followUpNoticePeriod: application.followUpNoticePeriod,
        customFollowUpAnswers: application.customFollowUpAnswers,
        jobCustomQuestions: job?.customFollowUpQuestions || (job as any)?.agent5CustomQuestions || [],
        candidateCustomCallData: candidate?.customCallData,
      }
    };
  },
});
