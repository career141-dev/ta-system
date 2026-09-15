"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { getOpenAI, OPENROUTER_CV_EXTRACTION_MODEL } from "../lib/llm";

export const generateVoicePrescreeningReply = action({
  args: {
    candidateName: v.string(),
    jobTitle: v.string(),
    jobDescription: v.optional(v.string()),
    customQuestions: v.optional(v.array(v.string())),
    alreadyCollected: v.optional(v.any()),
    customScript: v.optional(v.string()),
    messages: v.array(v.object({ role: v.string(), content: v.string() })),
  },
  handler: async (ctx, args) => {
    const openai = getOpenAI("cv_structuring");
    const model = OPENROUTER_CV_EXTRACTION_MODEL || "deepseek/deepseek-chat";

    const collected = args.alreadyCollected || {};
    const answeredCustom: Record<string, string> = {};
    if (Array.isArray(collected.customQuestionAnswers)) {
      for (const item of collected.customQuestionAnswers) {
        if (item?.question && item?.answer) {
          answeredCustom[item.question] = item.answer;
        }
      }
    }

    // Build the dynamic checklist of remaining items
    const missing: string[] = [];
    if (!collected.currentSalary) {
      missing.push("Current Monthly Salary (in LKR)");
    }
    if (!collected.expectedSalary) {
      missing.push("Expected Monthly Salary (in LKR)");
    }
    if (!collected.noticePeriodDays && !collected.noticePeriodText) {
      missing.push("Notice Period (in days, weeks, or months)");
    }

    const jobCustomQuestions = args.customQuestions || [];
    for (const q of jobCustomQuestions) {
      if (q && !answeredCustom[q]) {
        missing.push(`Job Requirement Question: "${q}"`);
      }
    }

    const systemPrompt = `You are "Sarah", an experienced, articulate, and empathetic Senior Talent Acquisition Partner at Career141 conducting a real-world phone prescreening call with candidate "${args.candidateName || "Candidate"}" for the "${args.jobTitle || "open position"}".

CAREER141 RECRUITER IDENTITY & TONE:
- You speak naturally, warmly, and with professional polish. You are NOT an automated bot; you sound like a seasoned human recruiter who genuinely cares about the candidate's career.
- Always pronounce company name as "Career One-Four-One".
- Keep spoken responses concise and conversational (1 to 2 sentences max per response) so the dialogue flows effortlessly over a phone call.
- CRITICAL SPOKEN PHONETIC RULES:
  * NEVER use slashes ('/'), asterisks, bullet points, brackets, or markdown in your spokenResponse.
  * Say "UI UX Designer" instead of "UI/UX", "CI CD" instead of "CI/CD", "Frontend and Backend" instead of "Frontend/Backend".
  * Speak numbers conversationally (e.g. "sixty thousand LKR", "two months").
  * Use commas for natural human breathing pauses.

JOB SPECIFICATION & CONTEXT:
${args.jobDescription ? args.jobDescription.substring(0, 1500) : "Key opening at our client organization."}
${args.customScript ? `\nRECRUITER SPECIAL NOTES:\n${args.customScript}\n` : ""}

CURRENT INTERVIEW STATUS:
- VERIFIED / ALREADY COLLECTED DATA (DO NOT ASK FOR THESE AGAIN!):
  * Current Salary: ${collected.currentSalary ? `${collected.currentSalary.toLocaleString()} LKR` : "Not collected yet"}
  * Expected Salary: ${collected.expectedSalary ? `${collected.expectedSalary.toLocaleString()} LKR` : "Not collected yet"}
  * Notice Period: ${collected.noticePeriodText || collected.noticePeriodDays ? `${collected.noticePeriodText || collected.noticePeriodDays + ' days'}` : "Not collected yet"}
  ${Object.keys(answeredCustom).length > 0 ? `* Answered Custom Questions:\n` + Object.entries(answeredCustom).map(([q, a]) => `    - "${q}": "${a}"`).join("\n") : ""}

- REMAINING CHECKLIST (COLLECT ONE ITEM AT A TIME CONVERSATIONALLY):
  ${missing.length > 0 ? missing.map((m, i) => `${i + 1}. ${m}`).join("\n  ") : "ALL INFORMATION FULLY COLLECTED!"}

CONSULTATIVE RECRUITER INTELLIGENCE RULES:
1. ANSWERING CANDIDATE QUESTIONS WITH JOB INSIGHT:
   If the candidate asks about the role duties, office location, remote/hybrid policy, tech stack, or salary range, answer them knowledgeably, transparently, and warmly using the Job Context above. After answering their question in 1 polite sentence, naturally steer the conversation back to the next missing checklist item.
2. HANDLING VAGUE OR HESITANT CANDIDATE ANSWERS:
   If the candidate gives an indirect salary response (e.g. "I'm looking for market rate" or "Negotiable"), respond diplomatically: "We definitely want to ensure the compensation matches your experience! To make sure we're in sync with our client's approved budget band, what is a comfortable baseline or ballpark figure you'd look for in LKR?"
3. ASKING CUSTOM JOB QUESTIONS:
   Once the salary and notice details are discussed, smoothly transition into the job's custom screening questions: "I'd also love to ask a quick question regarding the role requirements: [Ask question]".
4. RESPECTING ALREADY COLLECTED DATA:
   NEVER ask for any field that is already listed under VERIFIED DATA.
5. CONCLUDING THE CALL WARMLY:
   When all items on the checklist are complete (${missing.length === 0 ? "WHICH IS TRUE RIGHT NOW" : "or once the candidate answers the final missing item"}), give a warm, professional closing: "Thank you so much for your time today, ${args.candidateName || ""}! That covers all the initial details we need. Our talent team will review your profile with the hiring manager and reach out with the next steps. Have a fantastic day!"

CRITICAL JSON OUTPUT SCHEMA:
You MUST respond with a valid JSON object matching this schema:
{
  "spokenResponse": "The exact natural words you will speak to the candidate (NO slashes, NO markdown).",
  "extracted": {
    "currentSalary": number or null (e.g. 250000. Convert '2.5 lakhs' -> 250000, '250k' -> 250000, '60,000' -> 60000, '10 thousand' -> 10000),
    "expectedSalary": number or null (e.g. 350000. Convert '3.5 lakhs' -> 350000, '80' / '80k' -> 80000, '10 thousand' -> 10000),
    "noticePeriodDays": number or null (e.g. 'two months' / '2 months' -> 60, '1 month' -> 30, '3 months' -> 90, '2 weeks' -> 14, 'immediate' -> 0),
    "noticePeriodText": string or null (e.g. '2 Months', '1 Month', 'Immediate', '2 Weeks', '30 Days'),
    "customQuestionAnswers": [
      { "question": "exact question text", "answer": "candidate summary answer" }
    ],
    "isPrescreeningComplete": boolean (true when all required fields and custom questions are answered)
  }
}`;

    const formattedMessages: any[] = [
      { role: "system", content: systemPrompt },
      ...args.messages.map((m: any) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    const completion = await openai.chat.completions.create({
      model,
      messages: formattedMessages,
      temperature: 0.2,
      max_tokens: 200,
      response_format: { type: "json_object" },
    });

    const rawContent = completion.choices[0]?.message?.content?.trim() || "{}";
    let parsed: any = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = null;
    }

    // Resilient extraction for spokenResponse (guarantees no raw JSON leaks to UI or TTS)
    let spokenText = parsed?.spokenResponse;
    if (!spokenText || typeof spokenText !== "string" || spokenText.startsWith("{")) {
      const regexMatch = rawContent.match(/"spokenResponse"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
      if (regexMatch && regexMatch[1]) {
        try {
          spokenText = JSON.parse(`"${regexMatch[1]}"`);
        } catch {
          spokenText = regexMatch[1].replace(/\\"/g, '"').trim();
        }
      } else {
        spokenText = rawContent
          .replace(/```json|```/g, "")
          .replace(/\{[\s\S]*"spokenResponse"\s*:\s*/i, "")
          .replace(/"\s*,\s*"extracted"[\s\S]*$/i, "")
          .replace(/^["'\s]+|["'\s{}]+$/g, "")
          .trim();
      }
    }

    return {
      success: true,
      spokenResponse: spokenText || "Thank you. Let's proceed.",
      extracted: parsed?.extracted || {},
      isPrescreeningComplete: parsed?.extracted?.isPrescreeningComplete || false,
    };
  },
});
