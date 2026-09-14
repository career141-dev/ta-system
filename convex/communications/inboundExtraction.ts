import { internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { getOpenAI, getModelForTask } from "../lib/llm";
import { buildStructuredEmailHtml } from "./emailHtml";

export const extractDetailsFromText = internalAction({
  args: {
    candidateId: v.id("candidates"),
    textBody: v.string(),
    channel: v.optional(v.string()),
    inboxEmail: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Guard: skip extraction if text is empty or trivially short
    if (!args.textBody || args.textBody.trim().length < 3) {
      console.warn(`[Inbound Extraction] Skipping extraction — text body is empty or trivial: "${args.textBody}"`);
      return;
    }

    console.log(`[Inbound Extraction] Starting extraction for candidate ${args.candidateId} (channel: ${args.channel || "whatsapp"}). Text: "${args.textBody.substring(0, 200)}"`);

    const activeApp = await ctx.runQuery(api.candidates.candidates.getActiveFollowUpApplication, {
      candidateId: args.candidateId,
    });

    if (!activeApp) {
      console.log(`[Inbound Extraction] Candidate ${args.candidateId} has no active follow-up application. Skipping details update.`);
      return;
    }

    const job = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: activeApp.jobId });
    if (!job) {
      console.error(`[Inbound Extraction] Job ${activeApp.jobId} not found.`);
      return;
    }

    const candidate = await ctx.runQuery(api.candidates.candidates.getCandidate, { id: args.candidateId });

    const missingFields: string[] = [];
    const hasCV = activeApp.followUpCvReceived === true || !!candidate?.cvUploadId;
    const hasCurrentSalary = activeApp.followUpCurrentSalary === true || candidate?.currentSalary !== undefined;
    const hasExpectedSalary = activeApp.followUpExpectedSalary === true || candidate?.expectedSalary !== undefined;
    const hasNoticePeriod = activeApp.followUpNoticePeriod === true || candidate?.noticePeriodDays !== undefined;

    if (!hasCV) missingFields.push("CV Document");
    if (!hasCurrentSalary) missingFields.push("Current Salary");
    if (!hasExpectedSalary) missingFields.push("Expected Salary");
    if (!hasNoticePeriod) missingFields.push("Notice Period");

    const customQuestions = job.customFollowUpQuestions || [];
    const answeredCustomQuestions = activeApp.customFollowUpAnswers || {};
    for (const q of customQuestions) {
      if (!answeredCustomQuestions[q]) missingFields.push(q);
    }

    // Fetch conversation history
    const historyText = await ctx.runQuery(internal.communications.inboundExtraction.getRecentHistoryQuery, {
      candidateId: args.candidateId,
    });

    const toneMap: Record<string, string> = {
      warm_friendly: "Warm, encouraging, conversational, and helpful with natural emojis. Speak like a friendly talent acquisition colleague.",
      professional_formal: "Polite, clear, structured, corporate, and precise.",
      casual_tech: "Direct, tech-savvy, conversational, concise, and peer-to-peer.",
      direct_concise: "Short, prompt, to-the-point with minimal extra words.",
    };
    const selectedTone = toneMap[job.conversationTone || "professional_formal"] || (job.conversationTone ? `Custom tone: ${job.conversationTone}` : toneMap.professional_formal);

    const openai = getOpenAI("email_auto_reply");
    const model = getModelForTask("email_auto_reply");

    const systemPrompt = `You are an AI Talent Acquisition / Engagement Specialist for Career141 managing candidate follow-ups.
You are interacting like a real human recruitment colleague — NOT a robotic form.

JOB SPECIFICATION CONTEXT:
- Job Title: ${job.title}
- Company/Client: ${job.isConfidential ? `Confidential Search (Do NOT reveal client name; explain politely that this is a confidential hiring process conducted by Career141 for a premier ${job.clientIndustry || "organization"})` : (job.clientName || "Career141")}
- Location: ${job.location || "Colombo, Sri Lanka"}
- Workplace Type: ${(job as any).workplaceType || "Hybrid"}
- Job Description Summary: ${(job.jobDescription || "").substring(0, 400)}

CONVERSATION TONE TO USE:
${selectedTone}

Currently, before reading this message, these details are missing from candidate profile:
MISSING DETAILS BEFORE THIS MESSAGE: ${missingFields.join(", ")}

CONVERSATION HISTORY (most recent first):
${historyText || "No previous messages."}

To understand the TA's communication style, reference their templates:
INITIAL OUTREACH TEMPLATE:
"${(job.followUpInitialTemplate || 'Hi, please provide your missing details.').substring(0, 300)}"

SAMPLE FOLLOW-UP TEMPLATE:
"${(job.followUpSampleTemplate || 'Just checking in on the missing details. Please provide them at your earliest convenience.').substring(0, 300)}"

Your job is to analyze the candidate's LATEST/CURRENT message and output a JSON object.
Rules:
1. Extract missing numeric/text details from the CURRENT message if provided (currentSalary, expectedSalary, noticePeriodDays, noticePeriod, customAnswers, candidateSummary).
   - CANDIDATE SUMMARY / BIO: If the candidate introduces themselves, describes their background, career history, skills summary, or experience in their message, extract a clean 1-3 sentence summary into 'candidateSummary'.
   - STUDENTS/INTERNS/UNEMPLOYED SALARY: If a candidate states they are currently a student, undergraduate, intern, or currently unemployed with no work experience, automatically set 'currentSalary' to 0 (do not leave it as null).
   - NO NOTICE PERIOD: If a candidate states they do not have a notice period, are currently free, or can join immediately, set 'noticePeriodDays' to 0 and 'noticePeriod' to "0 Days".
   - CUSTOM ANSWERS KEY MATCHING: For each extracted answer in 'customAnswers', the key MUST EXACTLY MATCH the custom question string listed under MISSING DETAILS BEFORE THIS MESSAGE (e.g. use the exact full question text as the key, do not simplify it to "Portfolio" or "Portfolio Link").
2. Intent Classification & Writing nextActionMessage:
   - 'provided_all': Candidate provided ALL remaining missing details in this message. Set nextActionMessage to null.
   - 'provided_partial': Candidate provided some of the missing details in this message. Write a warm, human 'nextActionMessage' matching the CONVERSATION TONE that acknowledges what was received and naturally asks ONLY for the remaining missing fields. Do not use robotic bulleted email templates.
   - 'promised_eta': Use this ONLY IF the candidate's CURRENT message explicitly specifies a time/duration (e.g. "in 10 minutes", "tonight", "tomorrow at 3 PM", "in 2 hours"). Estimate 'candidateEtaMinutes' and write a polite acknowledgement matching CONVERSATION TONE confirming we will follow up after that time (e.g. "No problem! We'll follow up after tonight 😊").
   - 'interested_no_eta': Candidate expresses willingness or interest to send details (e.g. "Sure, I will send it", "I'm interested", "will share soon", "will do") WITHOUT specifying an exact time in their current message. Set candidateEtaMinutes: null, nextActionTimeHours: 24, and set nextActionMessage to a warm message asking by when they can share them. DO NOT copy or carry over any past ETA from conversation history!
   - 'asked_question': Candidate asked a question (e.g. company, salary, location, tech stack). Answer their question logically using the JOB SPECIFICATION CONTEXT above in the CONVERSATION TONE while pivoting back to ask for the remaining missing details. YOU MUST ALWAYS PROVIDE A REPLY MESSAGE.
   - 'not_interested': Candidate declined or is not interested. Set nextActionMessage to null.
3. 'nextActionTimeHours':
   - If 'promised_eta': A pure decimal number representing hours (e.g. 0.033 for 2 minutes, 0.083 for 5 minutes, 0.167 for 10 minutes, 1.0 for 1 hour, 24.0 for 24 hours). Output only a single valid JSON decimal number.
   - If 'interested_no_eta', 'provided_partial', or 'asked_question': Set to 24.
   - If 'provided_all' or 'not_interested': Set to null.
4. 'detectedQuestion': If candidate asked any question/inquiry in their message, analyze and categorize it into category ('salary_compensation' | 'visa_sponsorship' | 'location_remote' | 'notice_start_date' | 'tech_stack' | 'client_details' | 'general_inquiry') and importanceLevel ('high' | 'medium' | 'low').

Return ONLY a valid JSON object matching this schema. Do not add markdown formatting or backticks.
Schema:
{
  "currentSalary": number | null,
  "expectedSalary": number | null,
  "noticePeriodDays": number | null,
  "noticePeriod": string | null,
  "candidateSummary": string | null,
  "customAnswers": { [question: string]: string } | null,
  "intent": "provided_all" | "provided_partial" | "interested_no_eta" | "promised_eta" | "asked_question" | "not_interested",
  "candidateEtaMinutes": number | null,
  "nextActionTimeHours": number | null,
  "nextActionMessage": string | null,
  "detectedQuestion": {
    "hasQuestion": boolean,
    "questionText": string | null,
    "category": "salary_compensation" | "visa_sponsorship" | "location_remote" | "notice_start_date" | "tech_stack" | "client_details" | "general_inquiry" | null,
    "importanceLevel": "high" | "medium" | "low" | null
  } | null
}
If a field is not mentioned, return null for it. Do not invent or infer values.`;

    let completion = null;
    let attempts = 0;
    while (attempts < 3) {
      try {
        attempts++;
        completion = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: args.textBody },
          ],
          temperature: 0.1,
        });
        if (completion) break;
      } catch (llmErr: any) {
        console.warn(`[Inbound Extraction] Attempt ${attempts} LLM error: ${llmErr.message}`);
        if (llmErr?.message?.includes("Key limit exceeded") || llmErr?.message?.includes("403")) {
          console.error(`[Inbound Extraction ALERT] OpenRouter API Key spending limit reached on OpenRouter Dashboard!`);
          break;
        }
        if (attempts >= 3) throw llmErr;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    try {
      const responseText = completion?.choices[0]?.message?.content?.trim() || "";
      console.log(`[Inbound Extraction] Raw DeepSeek response: "${responseText}"`);

      let cleanJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      // Sanitize un-evaluated division expressions like ": 2.0 / 60"
      cleanJson = cleanJson.replace(/:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, (_: string, num: string, denom: string) => {
        const val = parseFloat(num) / parseFloat(denom);
        return `: ${val}`;
      });

      const firstBrace = cleanJson.indexOf("{");
      const lastBrace = cleanJson.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
      }

      const extracted = JSON.parse(cleanJson);

      // Check 72-hour ETA Ceiling Safeguard
      const etaMins = typeof extracted.candidateEtaMinutes === "number" && extracted.candidateEtaMinutes > 0 ? extracted.candidateEtaMinutes : null;
      const MAX_ETA_MINS = 72 * 60; // 72 hours ceiling

      if (etaMins && etaMins > MAX_ETA_MINS) {
        console.log(`[Inbound Extraction] Candidate ${args.candidateId} promised ETA of ${etaMins} mins (>72h). Flagging for TA review and pausing automated nudges.`);
        await ctx.runMutation(internal.communications.followUpMutations.flagForTaReview, {
          applicationId: activeApp._id,
          reason: `Candidate promised long ETA (${Math.round(etaMins / 60)} hours > 72h max ceiling)`,
        });
        return;
      }

      const updates: Record<string, any> = {};
      if (typeof extracted.currentSalary === "number") updates.currentSalary = extracted.currentSalary;
      if (typeof extracted.expectedSalary === "number") updates.expectedSalary = extracted.expectedSalary;
      
      if (typeof extracted.noticePeriodDays === "number") {
        updates.noticePeriodDays = extracted.noticePeriodDays;
        updates.noticePeriod = `${extracted.noticePeriodDays} Days`;
      } else if (typeof extracted.noticePeriod === "string" && extracted.noticePeriod.trim() !== "") {
        updates.noticePeriod = extracted.noticePeriod;
        let numDays = parseInt(extracted.noticePeriod.replace(/[^0-9]/g, ""), 10);
        if (!isNaN(numDays) && numDays > 0) {
          if (extracted.noticePeriod.toLowerCase().includes("month")) numDays *= 30;
          if (extracted.noticePeriod.toLowerCase().includes("week")) numDays *= 7;
          updates.noticePeriodDays = numDays;
        }
      }

      if (typeof extracted.candidateSummary === "string" && extracted.candidateSummary.trim() !== "") {
        updates.summary = extracted.candidateSummary.trim();
      }
      
      let finalCustomAnswers = undefined;
      if (extracted.customAnswers && Object.keys(extracted.customAnswers).length > 0) {
        const mappedCustomAnswers: Record<string, string> = {};
        for (const [key, val] of Object.entries(extracted.customAnswers)) {
          const valStr = String(val).trim();
          if (!valStr) continue;
          
          // Fuzzy match against job's custom follow up questions
          const matchedQuestion = customQuestions.find((q: string) => {
            const qNorm = q.toLowerCase();
            const keyNorm = key.toLowerCase();
            return qNorm.includes(keyNorm) || keyNorm.includes(qNorm) || 
                   (keyNorm.includes("portfolio") && qNorm.includes("portfolio")) ||
                   (keyNorm.includes("samples") && qNorm.includes("samples"));
          });
          
          if (matchedQuestion) {
            mappedCustomAnswers[matchedQuestion] = valStr;
          } else {
            mappedCustomAnswers[key] = valStr;
          }
        }
        
        finalCustomAnswers = { 
          ...(activeApp.customFollowUpAnswers || {}), 
          ...mappedCustomAnswers 
        };
        updates.customFollowUpAnswers = finalCustomAnswers;
      }

      // Candidate Inquiry placement (executed STRICTLY AFTER AI Analysis)
      try {
        const dq = extracted.detectedQuestion;
        const textLower = args.textBody.toLowerCase();
        const hasQuestion = dq?.hasQuestion === true || extracted.intent === "asked_question" || args.textBody.includes("?") ||
          textLower.includes("visa") || textLower.includes("remote") || textLower.includes("salary") || textLower.includes("relocat");

        if (hasQuestion) {
          let category: "salary_compensation" | "visa_sponsorship" | "location_remote" | "notice_start_date" | "tech_stack" | "client_details" | "general_inquiry" = dq?.category || "general_inquiry";
          let importanceLevel: "high" | "medium" | "low" = dq?.importanceLevel || "medium";

          if (!dq?.category) {
            if (textLower.includes("visa") || textLower.includes("sponsor")) {
              category = "visa_sponsorship";
              importanceLevel = "high";
            } else if (textLower.includes("salary") || textLower.includes("pay") || textLower.includes("compensation") || textLower.includes("package")) {
              category = "salary_compensation";
              importanceLevel = "high";
            } else if (textLower.includes("remote") || textLower.includes("location") || textLower.includes("office") || textLower.includes("relocat")) {
              category = "location_remote";
              importanceLevel = "high";
            } else if (textLower.includes("notice") || textLower.includes("start") || textLower.includes("join")) {
              category = "notice_start_date";
              importanceLevel = "medium";
            } else if (textLower.includes("tech") || textLower.includes("stack") || textLower.includes("framework")) {
              category = "tech_stack";
              importanceLevel = "medium";
            } else if (textLower.includes("client") || textLower.includes("company")) {
              category = "client_details";
              importanceLevel = "medium";
            }
          }

          await ctx.runMutation(internal.communications.inquiries.createInquiry, {
            candidateId: args.candidateId,
            applicationId: activeApp._id,
            jobId: activeApp.jobId,
            channel: "whatsapp",
            questionText: dq?.questionText || args.textBody,
            category,
            importanceLevel,
            aiAutoReplyText: extracted.nextActionMessage || undefined,
            status: extracted.nextActionMessage ? "answered_by_ai" : "unresolved",
          });
          console.log(`[Inbound Extraction] Placed post-analysis candidate inquiry (${category}, ${importanceLevel}) for candidate ${args.candidateId}`);
        }
      } catch (inqErr: any) {
        console.warn("[Inbound Extraction] Non-blocking inquiry logging error (safely swallowed):", inqErr.message || inqErr);
      }

      const hasUpdates = Object.keys(updates).length > 0 || extracted.cvReceived === true;
      const isQuestion = extracted.intent === "asked_question" || (extracted.detectedQuestion && extracted.detectedQuestion.hasQuestion === true) || args.textBody.includes("?");
      const isEta = extracted.intent === "promised_eta" || extracted.intent === "provided_eta" || extracted.intent === "interested_no_eta";

      if (hasUpdates || isQuestion || isEta || args.textBody.trim().length > 0) {
        if (hasUpdates) {
          console.log(`[Inbound Extraction] Extracted updates for candidate ${args.candidateId}:`, updates);
          await ctx.runMutation(api.candidates.candidates.updateCandidateDetails, {
            candidateId: args.candidateId,
            applicationId: activeApp._id,
            ...updates,
          });
        }

        // Re-fetch updated application and candidate data post-update
        const updatedCandidate = await ctx.runQuery(api.candidates.candidates.getCandidate, { id: args.candidateId });
        const updatedApp = await ctx.runQuery(api.candidates.candidates.getActiveFollowUpApplication, { candidateId: args.candidateId });

        // Fields still missing after this reply (plain names, used in prompt and reply messages)
        const appRecord = updatedApp || activeApp;
        const remainingMissing: string[] = [];
        if (!appRecord.followUpCvReceived && !updatedCandidate?.cvUploadId) remainingMissing.push("CV Document");
        if (!appRecord.followUpCurrentSalary && updatedCandidate?.currentSalary === undefined) remainingMissing.push("Current Salary");
        if (!appRecord.followUpExpectedSalary && updatedCandidate?.expectedSalary === undefined) remainingMissing.push("Expected Salary");
        if (!appRecord.followUpNoticePeriod && updatedCandidate?.noticePeriodDays === undefined && (!updatedCandidate?.noticePeriod || updatedCandidate?.noticePeriod === "")) remainingMissing.push("Notice Period");
        for (const q of customQuestions) {
          const ans = appRecord.customFollowUpAnswers || {};
          if (!ans[q]) remainingMissing.push(q);
        }

        // Strictly verify that ALL fields AND all custom questions are provided before declaring 100% complete
        const isCompleted = (updatedApp?.currentStage === "second_shortlist") || (remainingMissing.length === 0);

        let replyMessage: string | null = null;
        let aiAnswer: string | null = null;

        // Acknowledge the details that were successfully recorded in this reply
        const recordedDetails: string[] = [];
        if (typeof updates.currentSalary === "number") recordedDetails.push(`Current Salary: ${updates.currentSalary}`);
        if (typeof updates.expectedSalary === "number") recordedDetails.push(`Expected Salary: ${updates.expectedSalary}`);
        if (updates.noticePeriod) recordedDetails.push(`Notice Period: ${updates.noticePeriod}`);
        else if (typeof updates.noticePeriodDays === "number") recordedDetails.push(`Notice Period: ${updates.noticePeriodDays} days`);

        const preludeText =
          isCompleted
            ? `Great news! We have received all your application details for *${job.title}* and your profile is now 100% complete. Your application has been advanced to Second Shortlist.`
            : isQuestion
              ? `Thank you for your message regarding your application for *${job.title}*.`
              : `Thank you! We have recorded your update for *${job.title}*:`;

        if (isCompleted) {
          replyMessage = `Thank you ${updatedCandidate?.fullName || "there"}! We have received all your application details for *${job.title}*. Your profile is now 100% complete and has been advanced to Second Shortlist!`;
        } else if (extracted.intent === "promised_eta" || extracted.intent === "provided_eta") {
          replyMessage = extracted.nextActionMessage || `Got it! We'll follow up with you later.`;
          const hours = typeof extracted.nextActionTimeHours === "number" && extracted.nextActionTimeHours > 0 ? extracted.nextActionTimeHours : 6;
          await ctx.runMutation(internal.communications.followUpMutations.updateCandidateEta, {
            applicationId: activeApp._id,
            candidateEtaMs: Date.now() + (hours * 60 * 60 * 1000),
            candidateEtaText: extracted.nextActionMessage || "later",
            waitingForCandidateEta: true,
          });
        } else if (extracted.intent === "interested_no_eta") {
          replyMessage = extracted.nextActionMessage || `Great! Could you please let us know by what time you could provide these details?`;
        } else if (isQuestion) {
          const wpType = (job as any).workplaceType || "hybrid";
          aiAnswer = extracted.nextActionMessage || `This role is a ${wpType} position based in ${job.location || "Colombo, Sri Lanka"}.`;
          replyMessage = extracted.nextActionMessage || `This role is a ${wpType} position based in ${job.location || "Colombo, Sri Lanka"}.\n\nTo progress your application, please share:\n${remainingMissing.map(m => `• ${m}`).join("\n")}`;
        } else if (remainingMissing.length > 0) {
          replyMessage = extracted.nextActionMessage || `Hi ${updatedCandidate?.fullName?.split(" ")[0] || "there"},\n\n${preludeText}\n\nWe are still waiting on your ${remainingMissing.join(", ")} to progress your application. Please share these at your convenience. Thank you!`;
        }

        if (replyMessage) {
          const hours = typeof extracted.nextActionTimeHours === "number" && extracted.nextActionTimeHours > 0 ? extracted.nextActionTimeHours : 24;

          // IMPORTANT: Cancel any previously-pending follow-up BEFORE scheduling the new one.
          // Without this, the cron can still fire the old nextFollowUpScheduledAt timestamp
          // (which may be only minutes away) and send a duplicate message.
          await ctx.runMutation(internal.communications.followUpMutations.clearPendingFollowUp, {
            applicationId: activeApp._id,
          });

          if (!isCompleted && extracted.intent !== "provided_eta" && extracted.intent !== "promised_eta") {
            await ctx.runMutation(internal.communications.followUpMutations.scheduleDynamicFollowUp, {
              applicationId: activeApp._id,
              nextActionTimeHours: hours,
              messageBody: replyMessage,
            });
          }

          // Build the structured rich HTML rendering for the email channel
          const replyHtml = buildStructuredEmailHtml({
            candidateName: updatedCandidate?.fullName || "there",
            jobTitle: job.title,
            prelude: preludeText,
            aiAnswer,
            recordedDetails: recordedDetails.length > 0 ? recordedDetails : undefined,
            remainingMissing: remainingMissing.length > 0 ? remainingMissing : undefined,
          });

          // Send immediate reply over the originating channel (Email or WhatsApp)
          if (args.channel === "email") {
            const senderBox = args.inboxEmail || process.env.MS_SENDER_EMAIL || process.env.OUTBOUND_EMAIL_SENDER || "job@career141.com";
            const commId = await ctx.runMutation(internal.communications.emailAgent.createOutboundEmailRecord, {
              candidateId: args.candidateId,
              applicationId: activeApp._id,
              jobId: activeApp.jobId,
              subject: `Re: Application for ${job.title}`,
              body: replyMessage,
            });

            if (args.messageId) {
              await ctx.scheduler.runAfter(0, internal.communications.graphEmail.replyToMessage, {
                taEmail: senderBox,
                messageId: args.messageId,
                replyText: replyMessage,
                replyHtml,
              });
            } else {
              await ctx.scheduler.runAfter(0, internal.communications.graphEmail.sendGraphEmail, {
                communicationId: commId,
                candidateJobId: activeApp._id,
                taEmail: senderBox,
                toAddress: updatedCandidate?.email || candidate?.email || "",
                subject: `Re: Application for ${job.title}`,
                bodyHtml: replyHtml,
              });
            }
            console.log(`[Inbound Extraction] Dispatched immediate post-update EMAIL response to candidate ${args.candidateId}`);
          } else {
            const commId = await ctx.runMutation(internal.communications.whatsappOutbound.recordLocalWhatsappOutbound, {
              candidateId: args.candidateId,
              applicationId: activeApp._id,
              jobId: activeApp.jobId,
              body: replyMessage,
            });

            if (commId) {
              await ctx.scheduler.runAfter(0, internal.communications.whatsappOutbound.sendWhatsApp, {
                communicationId: commId,
                candidateId: args.candidateId,
                jobId: activeApp.jobId,
                body: replyMessage,
              });
              console.log(`[Inbound Extraction] Dispatched immediate post-update WHATSAPP response to candidate ${args.candidateId}`);
            } else {
              console.log(`[Inbound Extraction] Outbound WhatsApp message suppressed by deduplication for candidate ${args.candidateId}`);
            }
          }
        }
      } else {
        console.log(`[Inbound Extraction] No new updates extracted from message for candidate ${args.candidateId}. Suppressing duplicate reply loop.`);
      }

    } catch (err: any) {
      console.warn("[Inbound Extraction] Fail-open: Error during DeepSeek details extraction:", err.message);
      try {
        const fallbackHours = 24;
        const fallbackMsg = `Thank you! We've received your update regarding your *${job.title}* application. Please share any remaining details at your earliest convenience.`;
        await ctx.runMutation(internal.communications.followUpMutations.scheduleDynamicFollowUp, {
          applicationId: activeApp._id,
          nextActionTimeHours: fallbackHours,
          messageBody: fallbackMsg,
        });
      } catch (fallbackErr: any) {
        console.error("[Inbound Extraction] Fail-open fallback error:", fallbackErr.message);
      }
    }
  },
});

export const getRecentHistoryQuery = internalQuery({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("communications")
      .withIndex("by_candidate_time", (q) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .take(5);
    return messages.map(m => `[${m.direction}] ${m.subject || "Message"}: ${m.body}`).join("\n");
  }
});
