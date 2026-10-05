import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { getOpenAI, getModelForTask } from "../lib/llm";
import { postRoutingOn, routeByPosts, type EmailRoute } from "../pipeline/postFiling";
import { advanceCursor, notYetHandled, oldestFirst, POLL_BATCH, readsByLog } from "../lib/mailCursor";
import { isNotAnApplication, parseApplicationEmail } from "../lib/mailParse";
import { placeOnPosts } from "../mailIntake/process";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * A LinkedIn applicant whose notification carries no résumé (5 October). They
 * named themselves, the job and usually their profile, which is enough to hold
 * them and put them on the post: found by their LinkedIn profile, or created.
 * Until now the email was marked read and dropped, and the applicant was lost.
 * The newer mail reader (mailIntake/process.ts) does the same, and places them
 * through the same placeOnPosts.
 *
 * Returns the note for the mailbox log, or null when the email is not an
 * applicant notification (a LinkedIn notice, a digest, anything else).
 */
async function holdLinkedInApplicant(
  ctx: ActionCtx,
  input: { inboxEmail: string; subject: string; fromAddress: string; body: string; bodyIsHtml: boolean },
): Promise<string | null> {
  if (isNotAnApplication(input.fromAddress, input.subject)) return null;
  const parsed = parseApplicationEmail({
    subject: input.subject,
    fromAddress: input.fromAddress,
    bodyHtml: input.bodyIsHtml ? input.body : "",
    bodyText: input.bodyIsHtml ? "" : input.body,
  });
  if (!parsed.isLinkedIn || !parsed.applicantName) return null;

  const channel = inboxChannel(input.inboxEmail);
  const route = await routeByPosts(ctx, { subject: input.subject, body: input.body, channel });
  let candidateId: Id<"candidates"> | null = parsed.profileUrl
    ? await ctx.runQuery(internal.mailIntake.model.candidateByLinkedin, { url: parsed.profileUrl })
    : null;
  if (!candidateId) {
    candidateId = await ctx.runMutation(internal.candidates.candidates.createCandidate, {
      fullName: parsed.applicantName,
      linkedinUrl: parsed.profileUrl ?? undefined,
      email: parsed.email ?? undefined,
      phone: parsed.phone ?? undefined,
      sourceChannel: channel,
    });
  }
  if (!candidateId) return `CV not attached, and ${parsed.applicantName} could not be held.`;
  const posts = [
    ...(route.jobId && route.jobPostId ? [{ jobId: route.jobId, postId: route.jobPostId }] : []),
    ...route.alsoTo.map((a) => ({ jobId: a.jobId, postId: a.jobPostId })),
  ];
  await placeOnPosts(ctx, candidateId, posts, channel, input.subject);
  return `CV not attached — ${parsed.applicantName} held from the LinkedIn notification. ${route.note}`;
}

/** Which channel a shared mailbox's CVs are recorded under. */
function inboxChannel(inbox: string): string {
  const box = inbox.toLowerCase();
  if (inbox === process.env.LINKEDIN_SHARED_INBOX || box === "linkedin@career141.com") return "linkedin";
  return box === "cv@career141.com" ? "email" : "email_campaign";
}
import { emailAllowed, phoneAllowed, outboundLocked, suppressed } from "../lib/outboundGuard";
import { outreachLive, resolveRecipient } from "../lib/outreachSafety";
import { followUpCancelledReason, isEmail, sendFollowUpMail } from "../lib/graphMail";
import { refuseIfDoNotContact } from "../lib/doNotContact";
import { isFollowUpStage } from "../ta/stages";


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

/** The messages, and whether every page was read — a partial read must not move the cursor. */
async function fetchInboxEmails(inboxEmail: string, lastFetch: string | null, ignoreReadStatus: boolean = false): Promise<{ messages: any[]; fetchedAll: boolean }> {
  const token = await getGraphToken();
  if (!token) return { messages: [], fetchedAll: false };

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
    let fetchedAll = true;

    while (url) {
      const response = await safeFetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response || !response.ok) {
        console.error("[EmailAgent] Failed to fetch emails:", response ? await response.text() : "Network error");
        fetchedAll = false;
        break;
      }

      const data = await response.json();
      const messages = data.value || [];
      allMessages.push(...messages);
      
      // Handle pagination if more emails exist
      url = data["@odata.nextLink"];
    }

    return { messages: allMessages, fetchedAll };
  } catch (error) {
    console.error("[EmailAgent] Error fetching emails:", error);
    return { messages: [], fetchedAll: false };
  }
}

async function markEmailAsRead(inboxEmail: string, messageId: string) {
  // A test deployment reads the live mailboxes; it must not change them. A
  // message it marks read is one the production poller then never picks up.
  if (outboundLocked()) {
    console.log(`[EmailAgent] Outbound lock on: left ${messageId} unread in ${inboxEmail}`);
    return;
  }
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
export const pollEmailInbox = internalAction({
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
    // linkedin@ and cv@ are read by the log, not the read flag (lib/mailCursor.ts).
    const byLog = readsByLog(targetInboxEmail, process.env.LINKEDIN_SHARED_INBOX);
    const fetched = await fetchInboxEmails(targetInboxEmail, lastFetch, byLog || (ignoreReadStatus ?? false));
    const fetchedAll = fetched.fetchedAll;
    let messages = fetched.messages;
    if (byLog && messages.length > 0) {
      const logSince: string = await ctx.runMutation(internal.communications.emailAgent.startMailLog, { inboxEmail: targetInboxEmail });
      const logged: string[] = await ctx.runQuery(internal.communications.emailAgent.loggedMessageIds, {
        inboxEmail: targetInboxEmail,
        messageIds: messages.map((m: any) => m.id),
      });
      messages = notYetHandled(messages, new Set(logged), logSince);
    }
    // Record each email once it has been handled, and mark it read for whoever opens the mailbox.
    const finish = async (message: any, outcome: "cv" | "held" | "no_cv" | "reply", note?: string) => {
      await markEmailAsRead(targetInboxEmail, message.id);
      if (!byLog) return;
      await ctx.runMutation(internal.communications.emailAgent.logMailboxMessage, {
        inboxEmail: targetInboxEmail,
        messageId: message.id,
        receivedAt: message.receivedDateTime ?? new Date().toISOString(),
        subject: message.subject ?? "",
        fromAddress: message.from?.emailAddress?.address,
        outcome,
        note,
      });
    };
    if (messages.length > 0) {
      console.log(`[EmailAgent] Found ${messages.length} target messages in ${targetInboxEmail}.`);
    } else {
      console.log(`[EmailAgent] No matching messages found in ${targetInboxEmail}.`);
    }
    
    const allMessages = oldestFirst(messages);
    const batch = allMessages.slice(0, POLL_BATCH);
    if (allMessages.length > POLL_BATCH) {
      console.log(`[EmailAgent] ${allMessages.length} unread emails found. Processing the oldest ${POLL_BATCH}; the cursor stays, so the remaining ${allMessages.length - POLL_BATCH} are fetched again next run.`);
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
            // The reply itself is answered by extractDetailsFromText, which
            // checkAndRecordEmailReply has already scheduled. This used to ALSO
            // schedule generateAndSendAiEmailReply, so one candidate email got
            // two AI replies.
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
          await finish(message, "reply");
          continue;
        }
        // A LinkedIn applicant with no résumé: held and put on the post, on the
        // shared mailboxes, where post routing decides the job (5 October).
        if (postRoutingOn() && !jobId && senderEmail) {
          const held = await holdLinkedInApplicant(ctx, {
            inboxEmail: targetInboxEmail,
            subject,
            fromAddress: senderEmail,
            body: emailBody,
            bodyIsHtml: message.body?.contentType === "html",
          });
          if (held) {
            console.log(`[EmailAgent] ${held}`);
            await finish(message, "held", held);
            continue;
          }
        }
        console.log(`[EmailAgent] No CV attachments found in email: "${subject}"`);
        await finish(message, "no_cv");
        continue; // No CV attachment and not a follow-up reply — skip
      }
      
      // Intelligent Email Routing via LLMia LLM
      let resolvedJobId = jobId;

      // With C141_POST_ROUTING on, the job comes from the post rules alone —
      // LinkedIn job number, campaign code, exact title / old title / alias —
      // and nothing is guessed (pipeline/postFiling.ts, 22 September). A per-job
      // mailbox (jobId pinned) is its job already.
      let postRoute: EmailRoute | null = null;
      if (postRoutingOn() && !resolvedJobId) {
        postRoute = await routeByPosts(ctx, { subject, body: emailBody, channel: inboxChannel(targetInboxEmail) });
        resolvedJobId = postRoute.jobId;
        console.log(`[EmailAgent] ${postRoute.note}`);
      }

      // Fetch active jobs for LLM to evaluate — the old routing, used only
      // while post routing is off.
      const activeJobs = postRoutingOn() ? [] : await ctx.runQuery(internal.jobs.jobs.getActiveJobsBasicInfo);
      
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
          jobPostId: postRoute?.jobPostId,
          alsoTo: postRoute?.alsoTo.length ? postRoute.alsoTo : undefined,
          routeNote: postRoute?.note,
          rawSender: senderEmail,
          // Carried through so the routing downstream can read the headline.
          // It was read here and dropped, which left the only reliable signal
          // for WHICH advert a CV is for unavailable to the thing that files it.
          subject,
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

      await finish(
        message,
        "cv",
        `${cvAttachments.length} CV${cvAttachments.length > 1 ? "s" : ""}. ${postRoute?.note ?? (resolvedJobId ? "Filed to its job." : "No job matched, so the candidate went to the database.")}`,
      );
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
    // does not skip unprocessed messages on the next poll cycle — and only when
    // nothing was left behind (lib/mailCursor.ts, 5 October).
    // Read by the log, a held cursor cannot refetch the same mail forever, so the
    // outbound lock (mail left unread) does not matter there.
    if (advanceCursor({ fetchedAll, found: allMessages.length, markReadDisabled: outboundLocked() && !byLog })) {
      await ctx.runMutation(internal.communications.emailAgent.updateLastEmailFetchTimestamp, { timestamp: currentFetchTime, inboxEmail: targetInboxEmail });
    } else {
      console.log(`[EmailAgent] ${targetInboxEmail}: cursor kept at ${lastFetch ?? "(none)"} — ${fetchedAll ? `${allMessages.length - POLL_BATCH} message(s) still waiting` : "the mailbox could not be read in full"}.`);
    }
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
        internal.communications.emailAgent.pollEmailInbox,
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
    // In test mode every outbound email went to the test mailbox, so a reply
    // FROM the test mailbox belongs to whichever candidate was written to last.
    const testRecipient = (process.env.OUTREACH_TEST_EMAIL ?? "").trim();

    if (!outreachLive() && testRecipient && args.senderEmail.toLowerCase() === testRecipient.toLowerCase()) {
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

    // Recorded once per Graph message. Two pollEmailInbox runs overlapping (the
    // cron and a manual poll, or a slow run still going when the next began)
    // both saw the same unread email and each scheduled an AI reply, so the
    // candidate got two (2 Oct). This runs in a mutation, so the check and the
    // insert are one transaction: the second run sees the first one's row.
    if (args.messageId) {
      const seen = await ctx.db
        .query("communications")
        .withIndex("by_externalMessageId", (q: any) => q.eq("externalMessageId", args.messageId))
        .first();
      if (seen) {
        console.log(`[EmailAgent] Message ${args.messageId} was already recorded (communication ${seen._id}). Not recording or answering it again.`);
        return { isCandidateMatched: true, isFollowUpReply: false, duplicate: true };
      }
    }

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate._id))
      .order("desc")
      .collect();
    // The newest application in Follow-up is the one the assistant may chase
    // for; it used to take the newest application in ANY stage (2 Oct).
    const followUpApp = apps.find((a: any) => isFollowUpStage(a.currentStage));
    const activeApp = followUpApp ?? apps[0];

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
      externalMessageId: args.messageId,
    });

    if (followUpApp) {
      // Run text extraction in background to parse details and trigger dynamic email reply
      await ctx.scheduler.runAfter(0, internal.communications.inboundExtraction.extractDetailsFromText, {
        candidateId: candidate._id,
        textBody: args.body,
        channel: "email",
        inboxEmail: args.inboxEmail,
        messageId: args.messageId,
        senderEmail: args.senderEmail,
        // The application this email was matched to, just above.
        applicationId: followUpApp._id,
      });
    } else {
      console.log(`[EmailAgent] Email from candidate ${candidate._id} recorded; no application in Follow-up (${activeApp?.currentStage ?? "none"}), so no AI reply — a TA answers it.`);
    }


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
    const candidate = await ctx.runQuery(internal.candidates.candidates.getCandidate, {
      id: args.candidateId,
    });
    const job = await ctx.runQuery(internal.jobs.jobs.getJob, {
      jobId: args.jobId,
    });
    const app = await ctx.runQuery(internal.applications.applications.getApplication, {
      id: args.applicationId,
    });

    if (!candidate || !job || !app) {
      console.error("[EmailAgent AI Reply] Missing candidate, job, or application context.");
      return;
    }
    if (!isFollowUpStage(app.currentStage)) {
      console.log(`[EmailAgent AI Reply] Application ${args.applicationId} is not in Follow-up (${app.currentStage}). No AI reply.`);
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
    // replyToMessage marks the row sent once Graph accepts it, or failed with
    // the reason. This used to mark it sent here regardless, so a reply the
    // gates refused showed in the conversation as sent (2 Oct).
    await ctx.runAction(internal.communications.graphEmail.replyToMessage, {
      taEmail: args.inboxEmail,
      messageId: args.messageId,
      replyText: replyText,
      originalSender: candidate.email,
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

    const candidate = await ctx.runQuery(internal.candidates.candidates.getCandidateByEmail, {
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
      // Without this the extraction defaults to WhatsApp and answers an email
      // over WhatsApp — a channel the candidate never wrote on (23 September).
      channel: "email",
      senderEmail: args.senderEmail,
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

/** When this mailbox began to be read by the log; set on the first such run. */
export const startMailLog = internalMutation({
  args: { inboxEmail: v.string() },
  handler: async (ctx, { inboxEmail }): Promise<string> => {
    const key = `email_fetch_${inboxEmail}`;
    const row = await ctx.db.query("appSettings").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (row?.mailLogSince) return row.mailLogSince;
    const now = new Date().toISOString();
    if (row) await ctx.db.patch(row._id, { mailLogSince: now });
    else await ctx.db.insert("appSettings", { key, mailLogSince: now });
    return now;
  },
});

/** Which of these messages the log already holds. */
export const loggedMessageIds = internalQuery({
  args: { inboxEmail: v.string(), messageIds: v.array(v.string()) },
  handler: async (ctx, { inboxEmail, messageIds }): Promise<string[]> => {
    const out: string[] = [];
    for (const messageId of messageIds) {
      const hit = await ctx.db
        .query("mailboxLog")
        .withIndex("by_mailbox_message", (q) => q.eq("mailbox", inboxEmail).eq("messageId", messageId))
        .first();
      if (hit) out.push(messageId);
    }
    return out;
  },
});

export const logMailboxMessage = internalMutation({
  args: {
    inboxEmail: v.string(),
    messageId: v.string(),
    receivedAt: v.string(),
    subject: v.string(),
    fromAddress: v.optional(v.string()),
    outcome: v.union(v.literal("cv"), v.literal("held"), v.literal("no_cv"), v.literal("reply")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const hit = await ctx.db
      .query("mailboxLog")
      .withIndex("by_mailbox_message", (q) => q.eq("mailbox", a.inboxEmail).eq("messageId", a.messageId))
      .first();
    if (hit) return;
    await ctx.db.insert("mailboxLog", {
      mailbox: a.inboxEmail,
      messageId: a.messageId,
      receivedAt: a.receivedAt,
      subject: a.subject.slice(0, 300),
      fromAddress: a.fromAddress,
      outcome: a.outcome,
      note: a.note?.slice(0, 500),
      loggedAt: Date.now(),
    });
  },
});

export const checkFileHashExists = internalQuery({
  args: { fileHash: v.string() },
  handler: async (ctx, { fileHash }) => {
    const existing = await ctx.db
      .query("cvUploads")
      .withIndex("by_fileHash", (q) => q.eq("fileHash", fileHash))
      .first();
    return !!existing;
  },
});

export const processSingleRecoveredEmail = internalAction({
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

    // Post routing: the same rules as the live poller, no model (22 September).
    let postRoute: EmailRoute | null = null;
    if (postRoutingOn() && !resolvedJobId) {
      postRoute = await routeByPosts(ctx, { subject: subjectText, body: bodyText, channel: inboxChannel(args.targetInboxEmail) });
      resolvedJobId = postRoute.jobId;
      console.log(`[EmailRecovery] ${postRoute.note}`);
    }

    if (!resolvedJobId && !postRoutingOn()) {
      const activeJobs = await ctx.runQuery(internal.jobs.jobs.getActiveJobsBasicInfo);
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

      /*
       * Where the CV goes.
       *
       * With C141_TA_INTAKE on it goes to the queue: a row that is routed by
       * the mailbox it arrived at and the headline in the subject, read, and
       * then left for a person to admit. Nothing is written to the candidate
       * table until somebody says so, which is what makes "we received forty
       * and kept six" answerable.
       *
       * Off, it goes straight through as before. The switch is deliberately an
       * environment variable rather than a setting in the UI: turning it on
       * changes where every arriving CV lands, and that should take a deploy
       * and a decision, not a misclick.
       */
      if ((process.env.C141_TA_INTAKE ?? "").trim().toLowerCase() === "true") {
        await ctx.runAction(internal.ta.intakeReceive.receiveCv, {
          source: "email",
          receivedFrom: args.rawSender ?? null,
          // The address it arrived AT is what says whose adverts it can be
          // for — the old routing only ever looked at the subject.
          toAddress: args.targetInboxEmail,
          subject: args.subject ?? null,
          fileName: attachMeta.name ?? "cv.pdf",
          fileHash,
          s3Key,
          fileType: attachMeta.contentType || "application/pdf",
        });
      } else {
        await ctx.runMutation(internal.pipeline.ingestion.processCvIngestion, {
          jobId: resolvedJobId || undefined,
          jobPostId: postRoute?.jobPostId,
          alsoTo: postRoute?.alsoTo.length ? postRoute.alsoTo : undefined,
          routeNote: postRoute?.note,
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
      }

      delayMsOffset += 10000; // Add 10s delay between extractions of multiple attachments in same email
    }
  }
});

export const processSingleWeekendEmail = processSingleRecoveredEmail;
export const processSingleBulkIngestionEmail = processSingleRecoveredEmail;

export const recoverMailboxCVs = internalAction({
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

      await ctx.scheduler.runAfter(scheduleDelaySecs * 1000, internal.communications.emailAgent.processSingleRecoveredEmail, {
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

export const recoverCvFullInbox = internalAction({
  args: {
    targetJobId: v.optional(v.id("jobs")),
    daysLookback: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; totalMessagesChecked: number; cvEmailsQueued: number }> => {
    const targetInboxEmail = "cv@career141.com";
    console.log(`[CV Full Recovery] Triggering recovery for ${targetInboxEmail}...`);
    return await ctx.runAction(internal.communications.emailAgent.recoverMailboxCVs, {
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
    /** The assigned TA's mailbox it is sent from; the system sender when absent. */
    fromEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // A reminder queued before the TA stopped the sequence, or before the
    // candidate moved on, does not go — the same guard as the Day 0 email and
    // the WhatsApp sender.
    let candidateJobId: string | undefined;
    if (args.communicationId) {
      const comm = await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, {
        communicationId: args.communicationId,
      });
      const app = comm?.applicationId
        ? await ctx.runQuery(internal.communications.whatsappOutbound.getApplicationRecord, { applicationId: comm.applicationId })
        : null;
      const cancelled = followUpCancelledReason(comm, app);
      if (cancelled) {
        console.log(`[EmailAgent] ${cancelled} (communication ${args.communicationId})`);
        if (comm?.deliveryStatus !== "failed") {
          await ctx.runMutation(internal.communications.emailAgent.updateCommunicationStatus, {
            communicationId: args.communicationId,
            status: "failed",
            errorMessage: cancelled,
          });
        }
        return { success: false, error: cancelled };
      }
      candidateJobId = comm?.applicationId ? String(comm.applicationId) : undefined;
    }

    const comm = args.communicationId
      ? await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId })
      : null;
    const refusal = await refuseIfDoNotContact(ctx, "follow-up email", {
      candidateId: comm?.candidateId,
      email: args.candidateEmail,
    });
    if (refusal) {
      if (args.communicationId) {
        await ctx.runMutation(internal.communications.emailAgent.updateCommunicationStatus, {
          communicationId: args.communicationId,
          status: "failed",
          errorMessage: refusal,
        });
      }
      return { success: false, error: refusal };
    }

    // Sent through Microsoft Graph, gates first (lib/graphMail.ts), from the
    // assigned TA's mailbox. Replies go to the TA and to the system inbox, which
    // is polled and read into the record.
    const systemSender = process.env.OUTBOUND_EMAIL_SENDER || process.env.MS_SENDER_EMAIL;
    const senderEmail = args.fromEmail && isEmail(args.fromEmail) ? args.fromEmail.trim() : systemSender;
    const result = await sendFollowUpMail(
      {
        from: senderEmail,
        fallbackFrom: systemSender,
        to: args.candidateEmail,
        subject: args.subject,
        html: args.bodyHtml,
        text: args.body,
        replyTo: [senderEmail ?? "", process.env.MS_SENDER_EMAIL || systemSender || ""],
        candidateJobId,
      },
      getGraphToken,
    );

    if (result.ok) {
      console.log(`[EmailAgent] Follow-up email sent via Microsoft Graph from ${result.from} to ${result.to}${result.note}`);
    } else {
      console.warn(`[EmailAgent] Follow-up email not sent: ${result.error}`);
    }
    if (args.communicationId) {
      await ctx.runMutation(internal.communications.emailAgent.updateCommunicationStatus, {
        communicationId: args.communicationId,
        status: result.ok ? "sent" : "failed",
        errorMessage: result.ok ? undefined : result.error,
      });
    }
    return result.ok ? { success: true, error: "" } : { success: false, error: result.error };
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
    jobPostId: v.optional(v.id("jobPosts")),
    alsoTo: v.optional(v.array(v.object({ jobId: v.id("jobs"), jobPostId: v.id("jobPosts") }))),
    routeNote: v.optional(v.string()),
    rawSender: v.optional(v.string()),
    // The headline is what says WHICH of a TA's adverts this is for. The old
    // routing read it in the poller and threw it away before getting here, so
    // this action had no way to route on anything but the job it was handed.
    subject: v.optional(v.string()),
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

      const isAlreadyIngested = await ctx.runQuery(internal.communications.emailAgent.checkFileHashExists, { fileHash });
      if (isAlreadyIngested) {
        // The same CV sent for another job: with post routing, file the
        // person we already have to that job instead of dropping the email.
        // Nothing is uploaded again — ingestion links the existing candidate.
        if (postRoutingOn() && args.resolvedJobId) {
          await ctx.runMutation(internal.pipeline.ingestion.processCvIngestion, {
            jobId: args.resolvedJobId,
            jobPostId: args.jobPostId,
            alsoTo: args.alsoTo,
            routeNote: args.routeNote,
            sourceChannel: inboxChannel(args.targetInboxEmail),
            rawSender: args.rawSender,
            fileHash,
            fileName: args.attachmentName,
            fileType: args.contentType || "application/pdf",
            fileSizeBytes: fileBuffer.length,
            extractionDelayMs: args.currentExtractionDelayMs,
          });
          return;
        }
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

      // See the note on the other ingestion hand-off above: with
      // C141_TA_INTAKE on, an arriving CV joins the queue and becomes a
      // candidate only when a person admits it.
      if ((process.env.C141_TA_INTAKE ?? "").trim().toLowerCase() === "true") {
        await ctx.runAction(internal.ta.intakeReceive.receiveCv, {
          source: "email",
          receivedFrom: args.rawSender ?? null,
          toAddress: args.targetInboxEmail,
          subject: args.subject ?? null,
          fileName: args.attachmentName,
          fileHash,
          s3Key,
          fileType: args.contentType || "application/pdf",
        });
      } else {
        await ctx.runMutation(internal.pipeline.ingestion.processCvIngestion, {
          jobId: args.resolvedJobId || undefined,
          jobPostId: args.jobPostId,
          alsoTo: args.alsoTo,
          routeNote: args.routeNote,
          metaHeadline: postRoutingOn() && args.subject ? args.subject.slice(0, 200) : undefined,
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
      }
    } catch (e: any) {
      console.error(`[processSingleEmailAttachment] Error processing attachment ${args.attachmentName}:`, e.message);
    }
  },
});
