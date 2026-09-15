import { action, internalAction, internalMutation, query, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { getOpenAI, getModelForTask } from "../lib/llm";


// ----------------------------------------------------------------------------------
// MICROSOFT GRAPH API IMPLEMENTATION
// ----------------------------------------------------------------------------------

// Module-level token cache — persists across warm function invocations on the same worker
// MS Graph tokens are valid for 3600s; we expire ours at 3300s to be safe
let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

async function safeFetchWithRetry(url: string, init: RequestInit, retries: number = 3): Promise<Response | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      return res;
    } catch (err: any) {
      console.warn(`[EmailAgent Network] Attempt ${attempt}/${retries} failed for URL (${url.slice(0, 70)}...):`, err.message || err);
      if (attempt === retries) return null;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return null;
}

export async function getGraphToken(): Promise<string | null> {
  const tenantId = process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    console.log("[EmailAgent] Missing Microsoft Graph API credentials in environment variables (checked MS_GRAPH_TENANT_ID / MS_TENANT_ID).");
    return null;
  }

  // Return cached token if still valid (with 5-min buffer)
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt) {
    return _cachedToken;
  }

  try {
    const response = await safeFetchWithRetry(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: "https://graph.microsoft.com/.default",
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    });

    if (!response || !response.ok) {
      const errorText = response ? await response.text() : "Network unreachable";
      console.error("[EmailAgent] Failed to fetch Graph token:", errorText);
      return null;
    }

    const data = await response.json();
    _cachedToken = data.access_token;
    // Cache for (expires_in - 300) seconds, defaulting to 55 minutes
    _tokenExpiresAt = now + ((data.expires_in ?? 3600) - 300) * 1000;
    return _cachedToken;
  } catch (error) {
    console.error("[EmailAgent] Error fetching Graph token:", error);
    return null;
  }
}

async function fetchMessageAttachments(inboxEmail: string, messageId: string) {
  const token = await getGraphToken();
  if (!token) return [];

  try {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(inboxEmail)}/messages/${messageId}/attachments?$select=id,name,contentType,size`;
    const response = await safeFetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response || !response.ok) {
      console.error(`[EmailAgent] Failed to fetch attachments for message ${messageId}`);
      return [];
    }

    const data = await response.json();
    return data.value || [];
  } catch (error) {
    console.error(`[EmailAgent] Error fetching attachments for message ${messageId}:`, error);
    return [];
  }
}

async function fetchAttachmentContent(inboxEmail: string, messageId: string, attachmentId: string) {
  const token = await getGraphToken();
  if (!token) return null;

  try {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(inboxEmail)}/messages/${messageId}/attachments/${attachmentId}`;
    const response = await safeFetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response || !response.ok) {
      console.error(`[EmailAgent] Failed to fetch attachment content for ${attachmentId}`);
      return null;
    }

    const data = await response.json();
    return data.contentBytes || null;
  } catch (error) {
    console.error(`[EmailAgent] Error fetching attachment content for ${attachmentId}:`, error);
    return null;
  }
}

async function fetchInboxEmails(inboxEmail: string, lastFetch: string | null, ignoreReadStatus: boolean = false) {
  const token = await getGraphToken();
  if (!token) return [];

  const bypassReadCheck = ignoreReadStatus;

  console.log(`[EmailAgent] Fetching emails for ${inboxEmail} (bypassReadCheck=${bypassReadCheck}) since ${lastFetch || '30 days ago'}`);
  try {
    let cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (lastFetch) {
      const lastFetchTime = new Date(lastFetch).getTime();
      cutoffDate = new Date(Math.max(lastFetchTime - 5 * 60 * 1000, Date.now() - 30 * 24 * 60 * 60 * 1000)).toISOString();
    }

    let filterClause = `receivedDateTime ge ${cutoffDate}`;
    if (!bypassReadCheck) {
      filterClause = `isRead eq false and ` + filterClause;
    }

    let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(inboxEmail)}/mailFolders/inbox/messages?$filter=${filterClause}&$select=id,subject,body,from,hasAttachments,isRead,receivedDateTime&$top=100`;
    
    const allMessages: any[] = [];

    while (url) {
      const response = await safeFetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response || !response.ok) {
        console.error("[EmailAgent] Failed to fetch emails:", response ? await response.text() : "Network error");
        break;
      }

      const data = await response.json();
      const messages = data.value || [];
      allMessages.push(...messages);
      
      // Handle pagination if more emails exist
      url = data["@odata.nextLink"];
    }

    return allMessages;
  } catch (error) {
    console.error("[EmailAgent] Error fetching emails:", error);
    return [];
  }
}

async function markEmailAsRead(inboxEmail: string, messageId: string) {
  const token = await getGraphToken();
  if (!token) return;

  try {
    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(inboxEmail)}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isRead: true }),
    });

    if (!response.ok) {
      console.error(`[EmailAgent] Failed to mark message ${messageId} as read:`, await response.text());
    } else {
      console.log(`[EmailAgent] Marked message ${messageId} as read in ${inboxEmail}`);
    }
  } catch (error) {
    console.error(`[EmailAgent] Error marking message ${messageId} as read:`, error);
  }
}

async function sendConfirmationEmail(toEmail: string, jobId: string) {
  // Can be implemented using Graph API sendMail endpoint if needed
  console.log(`[Email Mock] Sent confirmation email to ${toEmail} for job ${jobId}`);
}
// ----------------------------------------------------------------------------------


// Runs as a scheduled Convex action — polls email every 2 minutes
export const pollEmailInbox = action({
  args: { 
    inboxEmail: v.string(), 
    jobId: v.optional(v.id("jobs")),
    ignoreReadStatus: v.optional(v.boolean()),
  },
  handler: async (ctx, { inboxEmail, jobId, ignoreReadStatus }) => {
    const targetInboxEmail = inboxEmail;
    if (targetInboxEmail.toLowerCase().includes("sanjeev")) {
      console.log(`[EmailAgent] Ingestion disabled for ${targetInboxEmail}. Skipping.`);
      return { success: false, reason: "sanjeev_inbox_disabled" };
    }
    console.log(`[EmailAgent] Polling inbox: ${targetInboxEmail}`);
    
    // Fetch last check timestamp for this specific inbox
    const lastFetch = await ctx.runQuery(internal.communications.emailAgent.getLastEmailFetchTimestamp, { inboxEmail: targetInboxEmail });
    
    // NOTE: Timestamp is committed AFTER batch processing completes, not before.
    // This prevents the cursor advancing past emails that weren't processed if a crash occurs.
    const currentFetchTime = new Date().toISOString();

    // 1. Fetch inbox emails (including read emails for Sanjeev or when ignoreReadStatus is true)
    const messages = await fetchInboxEmails(targetInboxEmail, lastFetch, ignoreReadStatus ?? false);
    if ((messages as any[]).length > 0) {
      console.log(`[EmailAgent] Found ${(messages as any[]).length} target messages in ${targetInboxEmail}.`);
    } else {
      console.log(`[EmailAgent] No matching messages found in ${targetInboxEmail}.`);
    }
    
    const allMessages = messages as any[];
    const batch = allMessages.slice(0, 15);
    if (allMessages.length > 15) {
      console.log(`[EmailAgent] ${allMessages.length} unread emails found. Processing top 15 in this run to prevent execution timeout (remaining ${allMessages.length - 15} will run in next 5-min cycle).`);
    }

    let currentExtractionDelayMs = 0; // Stagger AI extractions by 10s

    for (const message of batch) {
      console.log(`[EmailAgent] Processing message: ${message.subject} from ${message.from?.emailAddress?.address}`);
      let attachments = message.attachments || [];
      if (message.hasAttachments && attachments.length === 0) {
        console.log(`[EmailAgent] Message hasAttachments=true but pre-expanded attachments list is empty. Fetching individually...`);
        attachments = await fetchMessageAttachments(targetInboxEmail, message.id);
      }

      if (attachments.length > 0) {
        console.log(`[EmailAgent] Attachments found:`, attachments.map((a: any) => `${a.name} (${a.contentType})`));
      } else {
        console.log(`[EmailAgent] No attachments found on message.`);
      }

      const senderEmail = message.from?.emailAddress?.address;
      const subject = message.subject ?? "";
      const emailBody = ((typeof message.body === "object" && message.body !== null) 
        ? (message.body.content || "") 
        : (message.body || "")) || message.subject || "";

      let isReplyProcessed = false;
      let isCandidateMatched = false;

      // Check if it's a follow-up reply
      if (senderEmail) {
        const checkResult = await ctx.runMutation(internal.communications.emailAgent.checkAndRecordEmailReply, {
          senderEmail,
          subject,
          body: emailBody,
          messageId: message.id,
          inboxEmail: targetInboxEmail,
        });

        if (checkResult) {
          isCandidateMatched = !!checkResult.isCandidateMatched;

          if (checkResult.isFollowUpReply) {
            // Trigger automatic AI reply email
            await ctx.scheduler.runAfter(0, internal.communications.emailAgent.generateAndSendAiEmailReply, {
              inboxEmail: targetInboxEmail,
              messageId: message.id,
              candidateId: checkResult.candidateId as any,
              jobId: checkResult.jobId as any,
              applicationId: checkResult.applicationId as any,
              incomingBody: emailBody,
            });
            isReplyProcessed = true;
          }
        }
      }

      // 2. Find CV attachments (checking both content type and file extension)
      const cvAttachments = attachments.filter(
        (a: any) =>
          a.contentType?.includes("pdf") ||
          a.contentType?.includes("msword") ||
          a.contentType?.includes("officedocument.wordprocessingml") ||
          a.name?.toLowerCase().endsWith(".pdf") ||
          a.name?.toLowerCase().endsWith(".doc") ||
          a.name?.toLowerCase().endsWith(".docx")
      );

      if (cvAttachments.length === 0) {
        if (isReplyProcessed || isCandidateMatched) {
          await markEmailAsRead(targetInboxEmail, message.id);
          continue;
        }
        console.log(`[EmailAgent] No CV attachments found in email: "${subject}"`);
        await markEmailAsRead(targetInboxEmail, message.id);
        continue; // No CV attachment and not a follow-up reply — skip
      }
      
      // Intelligent Email Routing via LLMia LLM
      let resolvedJobId = jobId;
      
      // Fetch active jobs for LLM to evaluate
      const activeJobs = await ctx.runQuery(api.jobs.jobs.getActiveJobsBasicInfo);
      
      if (!resolvedJobId && activeJobs.length > 0) {
        // Fallback 1: Fast direct title / keyword matching from email subject
        const subjectLower = subject.toLowerCase();
        for (const j of activeJobs) {
          const titleLower = j.title.toLowerCase();
          const keywordLower = j.keyword ? j.keyword.toLowerCase() : "";
          if (
            subjectLower.includes(titleLower) ||
            (keywordLower && subjectLower.includes(keywordLower)) ||
            (titleLower.includes("full stack") && subjectLower.includes("full stack"))
          ) {
            resolvedJobId = j._id;
            console.log(`[EmailAgent] Fast title/keyword matched email "${subject}" to job: ${j.title} (${j._id})`);
            break;
          }
        }

        if (!resolvedJobId) {
          try {
            const openai = getOpenAI("email_routing");
            const model = getModelForTask("email_routing");
            
            const jobsListContext = activeJobs.map((j: any) => `- ID: ${j._id} | Title: ${j.title} | Client: ${j.clientName} | Keyword: ${j.keyword || "None"}`).join("\n");
            
            const prompt = `You are an intelligent recruitment email router.
Your task is to analyze an incoming email (subject and body) from a candidate and determine which active job they are applying for.

CRITICAL ROUTING RULES:
1. Perform semantic matching between the email subject/body and the active job "Title" (e.g. "Application for QA Manager" -> "Manager - Quality Assurance (Sweater)").
2. Pay close attention to the EMAIL SUBJECT. Job board notifications usually include the exact or approximate job title in the subject line.
3. If a job has a Keyword and it appears in the email subject or body, you can use it to confidently match the job.

ACTIVE JOBS:
${jobsListContext}

EMAIL SUBJECT: ${subject}
EMAIL BODY: ${emailBody.substring(0, 2000) /* limit length for context */}

Respond ONLY with a valid JSON object in this exact format:
{
  "matchedJobId": "string ID of the matched job, or null if absolutely no match could be determined"
}`;

            const completion = await openai.chat.completions.create({
              model: model,
              messages: [{ role: "user", content: prompt }],
              response_format: { type: "json_object" },
              temperature: 0.1,
            });
            
            const resultStr = completion.choices[0]?.message?.content;
            if (resultStr) {
              const resultObj = JSON.parse(resultStr);
              if (resultObj.matchedJobId) {
                // Verify the ID actually exists in our active jobs
                const matchedJob = activeJobs.find((j: any) => j._id === resultObj.matchedJobId);
                if (matchedJob) {
                  const channel = (targetInboxEmail === process.env.LINKEDIN_SHARED_INBOX || targetInboxEmail.toLowerCase() === "linkedin@career141.com") ? "linkedin" : (targetInboxEmail.toLowerCase() === "cv@career141.com" ? "email" : "email_campaign");
                  if (matchedJob.pausedChannels?.includes(channel)) {
                    console.log(`[EmailAgent] Job ${resultObj.matchedJobId} has ${channel} paused. Routing to general pool.`);
                    resolvedJobId = undefined;
                  } else {
                    resolvedJobId = resultObj.matchedJobId;
                    console.log(`[EmailAgent] AI successfully routed email to job: ${resolvedJobId}`);
                  }
                }
              }
            }
          } catch (error) {
            console.error("[EmailAgent] LLM routing failed", error);
          }
        }
      }
      
      // If AI couldn't match a job, do NOT skip the CV. Send to general DB pool.
      if (!resolvedJobId) {
        console.log(`[EmailAgent] No job match found for "${subject}". Routing to general DB pool.`);
      }


      // Dispatch CV attachment processing asynchronously with a 2-second stagger to prevent burst concurrency
      for (let attachIdx = 0; attachIdx < cvAttachments.length; attachIdx++) {
        const attachment = cvAttachments[attachIdx];
        console.log(`[EmailAgent] Found CV attachment: ${attachment.name} (${attachment.contentType}). Scheduling async background ingestion...`);

        await ctx.scheduler.runAfter(attachIdx * 2000, internal.communications.emailAgent.processSingleEmailAttachment, {
          targetInboxEmail,
          messageId: message.id,
          attachmentId: attachment.id,
          attachmentName: attachment.name ?? "cv.pdf",
          contentType: attachment.contentType || "application/pdf",
          resolvedJobId: resolvedJobId || undefined,
          rawSender: senderEmail,
          currentExtractionDelayMs,
        });

        currentExtractionDelayMs += 10000;
      }

      const isLinkedInNoReply = senderEmail?.toLowerCase().includes("jobs-listings@linkedin.com");
      const isInternalTeamEmail = senderEmail?.toLowerCase().endsWith("@career141.com");

      // Extract details from the email text body (salary, expected salary, notice period) for direct candidate emails
      if (senderEmail && !isLinkedInNoReply && !isInternalTeamEmail) {

        await ctx.scheduler.runAfter(0, internal.communications.emailAgent.extractAndApplyEmailBodyDetails, {
          senderEmail,
          emailBody,
        });
      }

      await markEmailAsRead(targetInboxEmail, message.id);
      /*
      if (!isReplyProcessed && !isLinkedInNoReply) {
        if (resolvedJobId) {
          await sendConfirmationEmail(message.from?.emailAddress?.address, resolvedJobId);
        } else {
          console.log(`[Email Mock] Sent generic confirmation email to ${message.from?.emailAddress?.address} for general application pool.`);
        }
      }
      */
    }

    // Commit the fetch timestamp AFTER all messages are processed so a mid-batch crash
    // does not skip unprocessed messages on the next poll cycle.
    await ctx.runMutation(internal.communications.emailAgent.updateLastEmailFetchTimestamp, { timestamp: currentFetchTime, inboxEmail: targetInboxEmail });
  },
});

// Internal query — returns all active per-job email channels that have an emailInbox configured
export const getActiveEmailJobChannels = internalQuery({
  args: {},
  handler: async (ctx) => {
    const channels = await ctx.db
      .query("jobChannels")
      .filter((q) =>
        q.and(
          q.eq(q.field("isEnabled"), true),
          q.neq(q.field("emailInbox"), undefined),
        )
      )
      .collect();

    // Keep only email-type channels that have a non-empty inbox address
    return channels
      .filter(
        (ch) =>
          ch.emailInbox &&
          ch.emailInbox.trim().length > 0 &&
          (ch.channelType === "email_campaign" || ch.channelType === "email")
      )
      .map((ch) => ({ jobId: ch.jobId, emailInbox: ch.emailInbox as string }));
  },
});

// Polls all per-job dedicated email inboxes that are enabled in jobChannels.
// The three system-level inboxes (linkedin@, cv@, job@) are handled by separate
// cron entries in crons.ts and are NOT re-polled here to avoid double-processing.
export const scheduleEmailPolling = internalAction({
  args: {},
  handler: async (ctx) => {
    // System inboxes — these are already polled by dedicated cron entries in crons.ts.
    // We skip them here to prevent double-processing.
    const SYSTEM_INBOXES = new Set([
      "linkedin@career141.com",
      "cv@career141.com",
      "job@career141.com",
    ]);

    const jobChannels = await ctx.runQuery(
      internal.communications.emailAgent.getActiveEmailJobChannels,
      {}
    );

    // De-duplicate inboxes (multiple jobs could share an inbox; poll each unique inbox once)
    const seen = new Set<string>();
    const toProcess: { jobId: any; emailInbox: string }[] = [];
    for (const ch of jobChannels) {
      const inboxKey = ch.emailInbox.toLowerCase().trim();
      if (SYSTEM_INBOXES.has(inboxKey)) continue; // already handled by cron
      if (seen.has(inboxKey)) continue;
      seen.add(inboxKey);
      toProcess.push(ch);
    }

    if (toProcess.length === 0) {
      return;
    }

    console.log(`[scheduleEmailPolling] Polling ${toProcess.length} per-job email inbox(es)...`);

    // Stagger each inbox poll by 15 s to spread load
    for (let i = 0; i < toProcess.length; i++) {
      const { emailInbox, jobId } = toProcess[i];
      await ctx.scheduler.runAfter(
        i * 15_000,
        api.communications.emailAgent.pollEmailInbox,
        { inboxEmail: emailInbox, jobId }
      );
    }
  },
});

export const checkAndRecordEmailReply = internalMutation({
  args: {
    senderEmail: v.string(),
    subject: v.string(),
    body: v.string(),
    messageId: v.optional(v.string()),
    inboxEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let targetEmail = args.senderEmail;
    const isTestMode = process.env.EMAIL_TEST_MODE === "true";
    const testRecipient = process.env.EMAIL_TEST_RECIPIENT;

    if (isTestMode && testRecipient && args.senderEmail.toLowerCase() === testRecipient.toLowerCase()) {
      const lastOutbound = await ctx.db
        .query("communications")
        .withIndex("by_channel_time", (q: any) => q.eq("channel", "email"))
        .filter((q: any) => q.eq(q.field("direction"), "outbound"))
        .order("desc")
        .first();

      if (lastOutbound) {
        const testCandidate = await ctx.db.get(lastOutbound.candidateId);
        if (testCandidate && testCandidate.email) {
          targetEmail = testCandidate.email;
          console.log(`[EmailAgent Test Mode] Mapped test sender ${args.senderEmail} to actual candidate email: ${targetEmail}`);
        }
      }
    }

    const candidate = await ctx.db
      .query("candidates")
      .withIndex("by_email", (q: any) => q.eq("email", targetEmail))
      .first();

    if (!candidate) return { isFollowUpReply: false, isCandidateMatched: false };

    const activeApp = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate._id))
      .order("desc")
      .first();

    await ctx.db.insert("communications", {
      candidateId: candidate._id,
      applicationId: activeApp?._id,
      jobId: activeApp?.jobId,
      direction: "inbound",
      channel: "email",
      subject: args.subject,
      body: args.body,
      deliveryStatus: "read",
      sentAt: Date.now(),
      stoppedSequence: false,
    });

    // Run text extraction in background to parse details and trigger dynamic email reply
    await ctx.scheduler.runAfter(0, internal.communications.inboundExtraction.extractDetailsFromText, {
      candidateId: candidate._id,
      textBody: args.body,
      channel: "email",
      inboxEmail: args.inboxEmail,
      messageId: args.messageId,
    });


    const isFollowUp =
      activeApp?.currentStage === "follow_up" ||
      (activeApp?.currentStage === "rejected" && activeApp?.taRejectionReason === "Did not complete requirements within 7-day window");

    return {
      isCandidateMatched: true,
      isFollowUpReply: isFollowUp,
      candidateId: candidate._id,
      applicationId: activeApp?._id,
      jobId: activeApp?.jobId,
    };
  },
});

export const generateAndSendAiEmailReply = internalAction({
  args: {
    inboxEmail: v.string(),
    messageId: v.string(),
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    applicationId: v.id("applications"),
    incomingBody: v.string(),
  },
  handler: async (ctx, args) => {
    const candidate = await ctx.runQuery(api.candidates.candidates.getCandidate, {
      id: args.candidateId,
    });
    const job = await ctx.runQuery(api.jobs.jobs.getJob, {
      jobId: args.jobId,
    });
    const app = await ctx.runQuery(api.applications.applications.getApplication, {
      id: args.applicationId,
    });

    if (!candidate || !job || !app) {
      console.error("[EmailAgent AI Reply] Missing candidate, job, or application context.");
      return;
    }

    const hasCV = !!candidate.cvUploadId || !!app.cvFileId || app.followUpCvReceived;
    const hasCurrentSalary = candidate.currentSalary !== undefined || app.followUpCurrentSalary;
    const hasExpectedSalary = candidate.expectedSalary !== undefined || app.followUpExpectedSalary;
    const hasNoticePeriod = candidate.noticePeriodDays !== undefined || app.followUpNoticePeriod;

    const missingFields = [];
    if (!hasCV) missingFields.push("updated CV/resume file");
    if (!hasCurrentSalary) missingFields.push("current salary");
    if (!hasExpectedSalary) missingFields.push("expected salary");
    if (!hasNoticePeriod) missingFields.push("notice period");

    let systemPrompt = `You are an AI recruitment assistant for Career141, a premium recruitment agency.
You are communicating with a candidate via email regarding their application for the job: "${job.title}".
Keep your email response:
1. Warm, professional, and polite.
2. Concise (2-3 short paragraphs max).
3. Say "Thank you" for their response/message.
4. Address their email queries naturally.
5. If they still have missing details that we need to proceed, politely remind them to provide those details.
   Here are the fields we are still waiting for: ${missingFields.join(", ") || "None (all details captured!)"}.
Do not mention database fields, variables, or system internals. Write the email body only.`;

    const openai = getOpenAI("email_auto_reply");
    const model = getModelForTask("email_auto_reply");

    console.log(`[EmailAgent AI Reply] Generating LLM response for candidate ${candidate.fullName}...`);
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Incoming email body from candidate: "${args.incomingBody}"` },
      ],
      temperature: 0.5,
    });

    const replyText = completion.choices[0]?.message?.content?.trim() || "Thank you for your message. We have received it and will get back to you shortly.";
    console.log(`[EmailAgent AI Reply] Generated reply: "${replyText.slice(0, 100)}..."`);

    const commId = await ctx.runMutation(internal.communications.emailAgent.createOutboundEmailRecord, {
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      subject: `Re: Application for ${job.title}`,
      body: replyText,
    });

    console.log(`[EmailAgent AI Reply] Dispatching reply through Microsoft Graph to ${candidate.email}...`);
    await ctx.runAction(internal.communications.graphEmail.replyToMessage, {
      taEmail: args.inboxEmail,
      messageId: args.messageId,
      replyText: replyText,
    });

    await ctx.runMutation(internal.communications.emailAgent.markOutboundEmailAsSent, {
      communicationId: commId,
    });
  },
});

export const createOutboundEmailRecord = internalMutation({
  args: {
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    subject: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("communications", {
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      direction: "outbound",
      channel: "email",
      subject: args.subject,
      body: args.body,
      deliveryStatus: "pending",
      sentAt: Date.now(),
      stoppedSequence: false,
    });
  },
});

export const markOutboundEmailAsSent = internalMutation({
  args: {
    communicationId: v.id("communications"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.communicationId, {
      deliveryStatus: "sent",
    });
  },
});

export const getLastOutboundEmailCommunication = internalQuery({
  args: {},
  handler: async (ctx: any) => {
    const lastOutbound = await ctx.db
      .query("communications")
      .withIndex("by_channel_time", (q: any) => q.eq("channel", "email"))
      .filter((q: any) => q.eq(q.field("direction"), "outbound"))
      .order("desc")
      .first();

    if (!lastOutbound) return null;
    
    const candidate = await ctx.db.get(lastOutbound.candidateId);
    return {
      candidateId: lastOutbound.candidateId,
      candidateEmail: candidate?.email,
    };
  }
});

export const extractAndApplyEmailBodyDetails = internalAction({
  args: {
    senderEmail: v.string(),
    emailBody: v.string(),
    _retryCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.senderEmail.toLowerCase().includes("sanjeev")) {
      return;
    }
    // Give up after 6 retries (6 × 20s = 120s max wait)
    if ((args._retryCount ?? 0) >= 6) {
      console.warn(`[Email Agent Inbound Details] Max retries reached for ${args.senderEmail} — giving up.`);
      return;
    }
    let lookupEmail = args.senderEmail;
    const isTestMode = process.env.EMAIL_TEST_MODE === "true";
    const testRecipient = process.env.EMAIL_TEST_RECIPIENT;

    if (isTestMode && testRecipient && args.senderEmail.toLowerCase() === testRecipient.toLowerCase()) {
      const lastOutbound = await ctx.runQuery(internal.communications.emailAgent.getLastOutboundEmailCommunication);
      if (lastOutbound && lastOutbound.candidateEmail) {
        lookupEmail = lastOutbound.candidateEmail;
      }
    }

    const candidate = await ctx.runQuery(api.candidates.candidates.getCandidateByEmail, {
      email: lookupEmail,
    });

    if (!candidate) {
      // Candidate not yet created (CV parsing still in flight) — retry in 20 seconds
      // instead of sleeping inside the action for up to 60 seconds
      await ctx.scheduler.runAfter(20000, internal.communications.emailAgent.extractAndApplyEmailBodyDetails, {
        senderEmail: args.senderEmail,
        emailBody: args.emailBody,
        _retryCount: (args._retryCount ?? 0) + 1,
      });
      console.log(`[Email Agent Inbound Details] Candidate not yet found for ${lookupEmail} — retrying in 20s (attempt ${(args._retryCount ?? 0) + 1}/6)`);
      return;
    }

    if (!candidate) {
      console.warn(`[Email Agent Inbound Details] Candidate not found for email: ${lookupEmail} after retries`);
      return;
    }

    await ctx.runAction(internal.communications.inboundExtraction.extractDetailsFromText, {
      candidateId: candidate._id,
      textBody: args.emailBody,
    });
  },
});

export const getLastEmailFetchTimestamp = internalQuery({
  args: { inboxEmail: v.optional(v.string()) },
  handler: async (ctx, { inboxEmail }) => {
    const key = inboxEmail ? `email_fetch_${inboxEmail}` : "system";
    const configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", key)).first();
    if (configRow?.lastEmailFetchTimestamp) return configRow.lastEmailFetchTimestamp;
    
    const systemRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
    return systemRow?.lastEmailFetchTimestamp ?? null;
  }
});

export const updateLastEmailFetchTimestamp = internalMutation({
  args: { timestamp: v.string(), inboxEmail: v.optional(v.string()) },
  handler: async (ctx, { timestamp, inboxEmail }) => {
    const key = inboxEmail ? `email_fetch_${inboxEmail}` : "system";
    const configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", key)).first();
    if (configRow) {
      await ctx.db.patch(configRow._id, { lastEmailFetchTimestamp: timestamp });
    } else {
      await ctx.db.insert("appSettings", { key, lastEmailFetchTimestamp: timestamp });
    }
  }
});

export const checkFileHashExists = query({
  args: { fileHash: v.string() },
  handler: async (ctx, { fileHash }) => {
    const existing = await ctx.db
      .query("cvUploads")
      .withIndex("by_fileHash", (q) => q.eq("fileHash", fileHash))
      .first();
    return !!existing;
  },
});

export const processSingleRecoveredEmail = action({
  args: {
    targetInboxEmail: v.string(),
    messageId: v.string(),
    subject: v.optional(v.string()),
    emailBody: v.optional(v.string()),
    targetJobId: v.optional(v.id("jobs")),
    rawSender: v.optional(v.string()),
    cvAttachments: v.any(), // Array of simplified attachment metadata
    extractionDelayMs: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. AI Routing logic
    let resolvedJobId: any = args.targetJobId ?? undefined;
    const subjectText = args.subject ?? "";
    const bodyText = args.emailBody ?? "";
    
    if (!resolvedJobId) {
      const activeJobs = await ctx.runQuery(api.jobs.jobs.getActiveJobsBasicInfo);
      if (activeJobs.length > 0) {
        try {
          const openai = getOpenAI("email_routing");
          const model = getModelForTask("email_routing");
          const jobsListContext = activeJobs.map((j: any) => `- ID: ${j._id} | Title: ${j.title} | Client: ${j.clientName} | Keyword: ${j.keyword || "None"}`).join("\n");
          const prompt = `You are an intelligent recruitment email router.
Your task is to analyze an incoming email (subject and body) from a candidate and determine which active job they are applying for.

CRITICAL ROUTING RULES:
1. Perform semantic matching between the email subject/body and the active job "Title".
2. Pay close attention to the EMAIL SUBJECT. Job board notifications usually include the exact or approximate job title in the subject line.
3. If a job has a Keyword and it appears in the email subject or body, you can use it to confidently match the job.

ACTIVE JOBS:
${jobsListContext}

EMAIL SUBJECT: ${subjectText}
EMAIL BODY: ${bodyText.substring(0, 2000)}

Respond ONLY with a valid JSON object in this exact format:
{
  "matchedJobId": "string ID of the matched job, or null if absolutely no match could be determined"
}`;

        const completion = await openai.chat.completions.create({
          model: model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.1,
        });
        const resultStr = completion.choices[0]?.message?.content;
        if (resultStr) {
          const resultObj = JSON.parse(resultStr);
          if (resultObj.matchedJobId) {
            const matchedJob = activeJobs.find((j: any) => j._id === resultObj.matchedJobId);
            if (matchedJob) {
              const channel = (args.targetInboxEmail.toLowerCase() === "linkedin@career141.com" || args.targetInboxEmail === process.env.LINKEDIN_SHARED_INBOX) ? "linkedin" : (args.targetInboxEmail.toLowerCase() === "cv@career141.com" ? "email" : "email_campaign");
              if (!matchedJob.pausedChannels?.includes(channel)) {
                resolvedJobId = resultObj.matchedJobId;
                console.log(`[EmailRecovery] AI successfully routed email to job: ${resolvedJobId}`);
              }
            }
          }
        }
      } catch (error) {
        console.error("[EmailRecovery] LLM routing failed", error);
      }
    }
    }

    // 2. Fetch attachments and store them
    let delayMsOffset = 0;
    for (const attachMeta of args.cvAttachments) {
      let contentBytes = attachMeta.contentBytes;
      if (!contentBytes) contentBytes = await fetchAttachmentContent(args.targetInboxEmail, args.messageId, attachMeta.id);
      if (!contentBytes) continue;

      const binaryString = atob(contentBytes);
      const fileBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        fileBuffer[i] = binaryString.charCodeAt(i);
      }
      
      const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
      const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      // Store in Cloudflare R2
      console.log("USING R2 NOW - UPLOADING TO CLOUDFLARE!"); const base64Data = contentBytes;
      const s3Key = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
        fileName: attachMeta.name ?? "cv.pdf",
        contentType: attachMeta.contentType || "application/pdf",
        base64Data,
      });

      const sourceChannel = (args.targetInboxEmail.toLowerCase() === "linkedin@career141.com" || args.targetInboxEmail === process.env.LINKEDIN_SHARED_INBOX) ? "linkedin" : (args.targetInboxEmail.toLowerCase() === "cv@career141.com" ? "email" : "email_campaign");

      await ctx.runMutation(api.pipeline.ingestion.processCvIngestion, {
        jobId: resolvedJobId || undefined,
        sourceChannel: sourceChannel,
        rawSender: args.rawSender,
        s3Key: s3Key,
        storageProvider: "r2",
        fileHash: fileHash,
        fileName: attachMeta.name ?? "cv.pdf",
        fileType: attachMeta.contentType || "application/pdf",
        fileSizeBytes: fileBuffer.length,
        extractionDelayMs: args.extractionDelayMs + delayMsOffset,
      });

      delayMsOffset += 10000; // Add 10s delay between extractions of multiple attachments in same email
    }
  }
});

export const processSingleWeekendEmail = processSingleRecoveredEmail;
export const processSingleBulkIngestionEmail = processSingleRecoveredEmail;

export const recoverMailboxCVs = action({
  args: {
    inboxEmail: v.optional(v.string()), // Defaults to "cv@career141.com"
    targetJobId: v.optional(v.id("jobs")),
    daysLookback: v.optional(v.number()), // Default 30 days
  },
  handler: async (ctx, args) => {
    const targetInboxEmail = args.inboxEmail || "cv@career141.com";
    if (targetInboxEmail.toLowerCase().includes("sanjeev")) {
      console.log(`[Mailbox Recovery] Ingestion for ${targetInboxEmail} is disabled. Aborting.`);
      return { success: false, totalMessagesChecked: 0, cvEmailsQueued: 0, reason: "sanjeev_inbox_disabled" };
    }
    const token = await getGraphToken();
    if (!token) throw new Error("No Graph token available");

    const days = args.daysLookback ?? 30;
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    console.log(`[Mailbox Recovery] Starting recovery for ${targetInboxEmail} (lookback ${days} days)...`);
    
    // Notice: NO 'isRead eq false' filter so read emails are included!
    let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(targetInboxEmail)}/mailFolders/inbox/messages?$filter=receivedDateTime ge ${cutoffDate}&$select=id,subject,body,from,hasAttachments,isRead&$top=100`;

    const allMessages: any[] = [];
    while (url) {
      const response = await safeFetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response || !response.ok) {
        const errorMsg = response ? await response.text() : "Network failure";
        console.error(`[Mailbox Recovery] Graph API response error: ${errorMsg}`);
        break;
      }
      const data = await response.json();
      allMessages.push(...(data.value || []));
      url = data["@odata.nextLink"];
    }

    console.log(`[Mailbox Recovery] Found ${allMessages.length} total messages in ${targetInboxEmail}. Filtering CV attachments...`);

    let totalQueued = 0;
    let scheduleDelaySecs = 0;

    for (const message of allMessages) {
      let attachments = message.attachments || [];
      if (message.hasAttachments && attachments.length === 0) {
        attachments = await fetchMessageAttachments(targetInboxEmail, message.id);
      }

      const cvAttachments = attachments.filter((a: any) =>
        a.contentType?.includes("pdf") || a.contentType?.includes("msword") ||
        a.contentType?.includes("officedocument.wordprocessingml") ||
        a.name?.toLowerCase().endsWith(".pdf") || a.name?.toLowerCase().endsWith(".doc") ||
        a.name?.toLowerCase().endsWith(".docx")
      );

      if (cvAttachments.length === 0) continue;

      const subject = message.subject ?? "";
      const emailBody = ((typeof message.body === "object" && message.body !== null) ? (message.body.content || "") : (message.body || "")) || message.subject || "";

      const attachMeta = cvAttachments.map((a: any) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBytes
      }));

      await ctx.scheduler.runAfter(scheduleDelaySecs * 1000, api.communications.emailAgent.processSingleRecoveredEmail, {
        targetInboxEmail,
        messageId: message.id,
        subject,
        emailBody,
        targetJobId: args.targetJobId,
        rawSender: message.from?.emailAddress?.address,
        cvAttachments: attachMeta,
        extractionDelayMs: 0,
      });

      scheduleDelaySecs += 10; // Queue 1 email every 10s to avoid rate limits
      totalQueued++;
    }

    console.log(`[Mailbox Recovery] Successfully scheduled ${totalQueued} CV emails for extraction from ${targetInboxEmail}.`);
    return { success: true, totalMessagesChecked: allMessages.length, cvEmailsQueued: totalQueued };
  }
});

export const recoverCvFullInbox = action({
  args: {
    targetJobId: v.optional(v.id("jobs")),
    daysLookback: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; totalMessagesChecked: number; cvEmailsQueued: number }> => {
    const targetInboxEmail = "cv@career141.com";
    console.log(`[CV Full Recovery] Triggering recovery for ${targetInboxEmail}...`);
    return await ctx.runAction(api.communications.emailAgent.recoverMailboxCVs, {
      inboxEmail: targetInboxEmail,
      targetJobId: args.targetJobId,
      daysLookback: args.daysLookback ?? 60,
    });
  },
});

export const sendFollowUpEmail = internalAction({
  args: {
    communicationId: v.optional(v.id("communications")),
    candidateEmail: v.string(),
    subject: v.string(),
    body: v.string(),
    bodyHtml: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const senderEmail = process.env.OUTBOUND_EMAIL_SENDER || process.env.MS_SENDER_EMAIL;
    if (!senderEmail) {
      throw new Error("[EmailAgent] MS_SENDER_EMAIL or OUTBOUND_EMAIL_SENDER environment variable is not configured.");
    }
    console.log(`[EmailAgent] Sending outbound follow-up email to ${args.candidateEmail} from ${senderEmail}`);

    const token = await getGraphToken();
    let sentSuccess = false;
    let errorMessage = "";
    const replyTo = process.env.MS_SENDER_EMAIL || senderEmail;

    if (token) {
      try {
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject: args.subject,
              body: {
                contentType: args.bodyHtml ? "HTML" : "Text",
                content: args.bodyHtml || args.body,
              },
              toRecipients: [
                {
                  emailAddress: {
                    address: args.candidateEmail,
                  },
                },
              ],
              replyTo: [
                {
                  emailAddress: {
                    address: replyTo,
                  },
                },
              ],
            },
            saveToSentItems: "true",
          }),
        });

        if (res.ok) {
          sentSuccess = true;
          console.log(`[EmailAgent] Outbound email sent successfully via MS Graph to ${args.candidateEmail}`);
        } else {
          errorMessage = await res.text();
          console.error(`[EmailAgent] MS Graph sendMail failed (${res.status}): ${errorMessage}`);
        }
      } catch (err: any) {
        errorMessage = err.message || String(err);
        console.error(`[EmailAgent] MS Graph exception: ${errorMessage}`);
      }
    }

    // Fallback: If direct MS Graph call failed or token was unavailable on Docker, proxy through Next.js API route
    if (!sentSuccess) {
      try {
        console.log(`[EmailAgent] Attempting Next.js API route fallback (http://127.0.0.1:3000/api/email/send-followup)...`);
        const nextApiRes = await fetch("http://127.0.0.1:3000/api/email/send-followup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateEmail: args.candidateEmail,
            subject: args.subject,
            body: args.body,
          }),
        });

        if (nextApiRes.ok) {
          const resData = await nextApiRes.json();
          if (resData.success) {
            sentSuccess = true;
            errorMessage = "";
            console.log(`[EmailAgent] Outbound email sent successfully via Next.js API route to ${args.candidateEmail}`);
          } else {
            errorMessage = resData.error || "Next.js API route returned failure";
          }
        } else {
          errorMessage = `Next.js API route returned HTTP ${nextApiRes.status}: ${await nextApiRes.text()}`;
        }
      } catch (nextApiErr: any) {
        console.error("[EmailAgent] Next.js API route fallback exception:", nextApiErr.message || nextApiErr);
      }
    }

    if (args.communicationId) {
      await ctx.runMutation(internal.communications.emailAgent.updateCommunicationStatus, {
        communicationId: args.communicationId,
        status: sentSuccess ? "sent" : "failed",
        errorMessage: sentSuccess ? undefined : errorMessage,
      });
    }

    return { success: sentSuccess, error: errorMessage };
  },
});

export const updateCommunicationStatus = internalMutation({
  args: {
    communicationId: v.id("communications"),
    status: v.union(v.literal("sent"), v.literal("delivered"), v.literal("read"), v.literal("replied"), v.literal("failed"), v.literal("cancelled")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.communicationId, {
      deliveryStatus: args.status === "sent" ? "sent" : "failed",
      status: args.status,
      errorMessage: args.errorMessage,
    });
  },
});

export const processSingleEmailAttachment = internalAction({
  args: {
    targetInboxEmail: v.string(),
    messageId: v.string(),
    attachmentId: v.string(),
    attachmentName: v.string(),
    contentType: v.string(),
    resolvedJobId: v.optional(v.id("jobs")),
    rawSender: v.optional(v.string()),
    currentExtractionDelayMs: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      console.log(`[processSingleEmailAttachment] Fetching content for attachment: ${args.attachmentName}`);
      const contentBytes = await fetchAttachmentContent(args.targetInboxEmail, args.messageId, args.attachmentId);
      if (!contentBytes) {
        console.error(`[processSingleEmailAttachment] Failed to get contentBytes for attachment ${args.attachmentName}`);
        return;
      }

      const binaryString = atob(contentBytes);
      const fileBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        fileBuffer[i] = binaryString.charCodeAt(i);
      }

      const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer.buffer as ArrayBuffer);
      const fileHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

      const isAlreadyIngested = await ctx.runQuery(api.communications.emailAgent.checkFileHashExists, { fileHash });
      if (isAlreadyIngested) {
        console.log(`[processSingleEmailAttachment] Attachment ${args.attachmentName} (${fileHash.slice(0, 8)}) already ingested. Skipping upload.`);
        return;
      }

      console.log(`[processSingleEmailAttachment] Uploading ${args.attachmentName} to Cloudflare R2...`);
      const s3Key = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
        fileName: args.attachmentName,
        contentType: args.contentType || "application/pdf",
        base64Data: contentBytes,
      });

      const sourceChannel = (args.targetInboxEmail === process.env.LINKEDIN_SHARED_INBOX || args.targetInboxEmail.toLowerCase() === "linkedin@career141.com") ? "linkedin" : (args.targetInboxEmail.toLowerCase() === "cv@career141.com" ? "email" : "email_campaign");

      await ctx.runMutation(api.pipeline.ingestion.processCvIngestion, {
        jobId: args.resolvedJobId || undefined,
        sourceChannel,
        rawSender: args.rawSender,
        s3Key,
        storageProvider: "r2",
        fileHash,
        fileName: args.attachmentName,
        fileType: args.contentType || "application/pdf",
        fileSizeBytes: fileBuffer.length,
        extractionDelayMs: args.currentExtractionDelayMs,
      });
    } catch (e: any) {
      console.error(`[processSingleEmailAttachment] Error processing attachment ${args.attachmentName}:`, e.message);
    }
  },
});
