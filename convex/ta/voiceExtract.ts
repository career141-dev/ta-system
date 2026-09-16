// convex/ta/voiceExtract.ts
//
// Reading an Aura screening call's answers out of its transcript.
//
// The CV pipeline's Aura agent collects the details in conversation but never
// writes them anywhere. Here, once the call window hands back the transcript
// (ta/voice.ts `completeWebCall`), a model reads current salary, expected
// salary, notice period and the opening's own questions from what the
// candidate said, and `applyCallAnswers` fills them in. What the model
// returns is checked before anything is written (lib/screeningCall.ts).

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getModelForTask, getOpenAI } from "../lib/llm";
import { extractionPrompt, normaliseCallAnswers, parseJsonObject } from "../lib/screeningCall";

export const extractCallAnswers = internalAction({
  args: { aiCallId: v.id("aiCalls") },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; filled?: string[] }> => {
    const call = await ctx.runQuery(internal.ta.voice.callForExtraction, { aiCallId: args.aiCallId });
    if (!call || !call.transcript.trim()) return { ok: false, error: "No transcript to read." };

    let text = "";
    try {
      const completion = await getOpenAI("voice_call_extraction").chat.completions.create({
        model: getModelForTask("voice_call_extraction"),
        temperature: 0,
        messages: [
          { role: "system", content: "You extract structured facts from recruitment call transcripts. Reply with JSON only." },
          { role: "user", content: extractionPrompt(call.questions, call.transcript) },
        ],
      });
      text = completion.choices[0]?.message?.content ?? "";
    } catch (e) {
      const error = `The call's answers could not be read: ${(e as Error).message}`;
      console.error(`[Aura call] ${error}`);
      return { ok: false, error };
    }

    const parsed = parseJsonObject(text);
    if (!parsed) {
      console.error(`[Aura call] The model did not return JSON for call ${args.aiCallId}.`);
      return { ok: false, error: "The model did not return JSON." };
    }
    const answers = normaliseCallAnswers(parsed, call.questions);
    const result = await ctx.runMutation(internal.ta.voice.applyCallAnswers, { aiCallId: args.aiCallId, answers });
    console.log(`[Aura call] Answers read for call ${args.aiCallId}; filled on the candidate: ${result.filled.join(", ") || "nothing new"}.`);
    return { ok: result.ok, filled: result.filled };
  },
});
