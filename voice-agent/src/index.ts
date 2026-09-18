// voice-agent/src/index.ts
//
// Aura, the TA System's screening call agent — a LiveKit Agents worker,
// modelled on the CV pipeline's Aura agent (cv-processing-recruitment-pipeline-
// system/agent/src/index.ts): Silero VAD, Deepgram Nova speech-to-text,
// GPT-4o-mini, Deepgram Aura voice.
//
// It registers under an agent name, so it joins only rooms the TA System
// dispatches it to (src/app/voiceActions.ts), never every room on the server.
// It reads the call brief from the room metadata (convex/ta/voice.ts), opens
// the call, works the checklist, and sends every finished line to the call
// window on the `aura-transcript` topic. The window hands that transcript back
// when the call ends, and the answers are read from it.
//
// Run locally:  cd voice-agent && npm install && npm run dev

import {
  type JobContext,
  type JobProcess,
  type VAD,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openingInstruction, readBrief, systemPrompt } from "./prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The TA System's own environment (ta-system/.env.local), then this folder's.
dotenv.config({ path: path.resolve(here, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(here, "../.env"), quiet: true });

export const AGENT_NAME = (process.env.AURA_AGENT_NAME ?? "").trim() || "career141-aura";
export const TRANSCRIPT_TOPIC = "aura-transcript";
const MAX_CALL_MS = 8 * 60 * 1000;

function need(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`[Aura] Missing ${name}`);
  return value;
}

// LiveKit: the worker connects to the same server the TA System creates rooms on.
process.env.LIVEKIT_URL = (process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "")
  .trim()
  .replace(/^http(s?):\/\//i, "ws$1://");
need("LIVEKIT_URL");
need("LIVEKIT_API_KEY");
need("LIVEKIT_API_SECRET");
const DEEPGRAM_API_KEY = need("DEEPGRAM_API_KEY");
// OpenAI directly, as the CV platform's agent does. There is no OpenRouter
// fallback on purpose: that account serves only deepseek-v4-flash, so falling
// back to `openai/gpt-4o-mini` there would turn a key problem into a call where
// Aura never speaks.
const OPENAI_API_KEY = need("OPENAI_API_KEY");

/**
 * A provider hiccup must not end the call.
 *
 * Node 22 exits the process on an unhandled rejection, and a call is full of
 * promises nobody awaits (speech, playout). Without these the worker died
 * mid-call and the window just went quiet.
 */
process.on("uncaughtException", (err) => console.error("[Aura] Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.warn("[Aura] Unhandled promise rejection:", reason));

/**
 * How Aura decides the candidate has finished speaking — the CV platform's
 * settings, which are the difference between a reply in a second and one in
 * seventeen (17 September, a caller said "Yes" three times and hung up).
 *
 * `stt` turn detection ends a turn on Deepgram's own endpoint rather than
 * waiting for silence; preemptive TTS starts speaking while the answer is
 * still being written; `minWords: 2` stops a cough or a "mm" cutting Aura off
 * mid-sentence.
 */
const TURN_HANDLING = {
  turnDetection: "stt" as const,
  endpointing: { minDelay: 300, maxDelay: 1500 },
  interruption: { enabled: true, mode: "adaptive" as const, minWords: 2, falseInterruptionTimeout: 500 },
  preemptiveGeneration: { enabled: true, preemptiveTts: true },
};

type UserData = { vad?: VAD };

function textOf(item: any): string {
  if (!item) return "";
  if (typeof item.textContent === "string") return item.textContent;
  const content = Array.isArray(item.content) ? item.content : [item.content];
  return content.filter((c: unknown) => typeof c === "string").join(" ");
}

export default defineAgent<UserData>({
  prewarm: async (proc: JobProcess<UserData>) => {
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: 300,
      minSpeechDuration: 100,
      // Keeps the first syllable of an answer, which endpointing otherwise clips.
      prefixPaddingDuration: 300,
    });
  },

  entry: async (ctx: JobContext<UserData>) => {
    const vad = ctx.proc.userData.vad;
    if (!vad) throw new Error("[Aura] VAD did not load");
    await ctx.connect();

    const brief = readBrief(ctx.room.metadata);
    console.info(`[Aura] Call starting [room=${ctx.room.name}] [role=${brief.jobTitle}] [items=${brief.detailsToCollect.length}]`);

    const stt = new deepgram.STT({
      apiKey: DEEPGRAM_API_KEY,
      model: "nova-2-general",
      language: "en",
      endpointing: 300,
      smartFormat: true,
      interimResults: true,
      mipOptOut: true,
    });
    // A screening question is one or two sentences. Uncapped, the model wrote
    // paragraphs and the candidate waited through all of them.
    const llm = new openai.LLM({ apiKey: OPENAI_API_KEY, model: "gpt-4o-mini", temperature: 0.2, maxCompletionTokens: 120 });
    const tts = new deepgram.TTS({ apiKey: DEEPGRAM_API_KEY, model: "aura-2-asteria-en", sampleRate: 24_000, mipOptOut: true });

    const session = new voice.AgentSession({
      vad,
      stt,
      llm,
      tts,
      // The browser already cancels its own echo; three seconds of warm-up only
      // stopped the candidate interrupting at the start of every answer.
      aecWarmupDuration: 0,
      ttsReadIdleTimeout: 10_000,
      forwardAudioIdleTimeout: 10_000,
      turnHandling: TURN_HANDLING,
    });

    // Each finished line goes to the call window, which keeps the transcript.
    const encoder = new TextEncoder();
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event: any) => {
      const role = event?.item?.role;
      const text = textOf(event?.item).trim();
      if (!text || (role !== "assistant" && role !== "user")) return;
      const line = { type: "line", who: role === "assistant" ? "agent" : "candidate", text, at: Date.now() };
      void ctx.room.localParticipant
        ?.publishData(encoder.encode(JSON.stringify(line)), { reliable: true, topic: TRANSCRIPT_TOPIC })
        .catch((e: unknown) => console.warn("[Aura] Could not send a transcript line", e));
    });
    session.on(voice.AgentSessionEventTypes.Error, (event: any) => console.error("[Aura] Session error", event?.error));

    // Enough to read a call back afterwards: when each answer was final, and
    // when Aura started speaking. Without these a slow call looks like a silent
    // one in the log.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event: any) => {
      if (event?.transcript?.trim()) console.info(`[Aura] heard (final=${event.isFinal ?? true}): "${event.transcript.trim()}"`);
    });
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (event: any) => {
      if (event?.text?.trim()) console.info(`[Aura] speaking: "${event.text.trim()}"`);
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (e: any) => console.info(`[Aura] agent ${e?.state}`));
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (e: any) => console.info(`[Aura] candidate ${e?.state}`));

    // The call window's "Or type an answer…" box. Without this the typed reply
    // was decoded by nobody and the candidate was met with silence.
    ctx.room.on("dataReceived", (payload: Uint8Array, _participant?: unknown) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; text?: string };
        const typed = data?.type === "candidate_reply" ? (data.text ?? "").trim() : "";
        if (!typed) return;
        console.info(`[Aura] typed: "${typed}"`);
        session.generateReply({ instructions: `The candidate typed this answer: "${typed}". Take it as their reply and carry on.` });
      } catch (e) {
        console.warn("[Aura] Unreadable data message", e);
      }
    });

    await ctx.waitForParticipant();
    await session.start({
      agent: new voice.Agent({ instructions: systemPrompt(brief), turnHandling: TURN_HANDLING, llm, stt, tts, vad }),
      room: ctx.room,
      record: false,
    });

    const cap = setTimeout(() => {
      console.warn(`[Aura] Call cap reached [room=${ctx.room.name}]`);
      session.say("We're out of time for this call, so I'll let you go. Thank you, and the Career141 team will be in touch.");
      setTimeout(() => void ctx.deleteRoom().finally(() => ctx.shutdown("call_cap")), 8000);
    }, MAX_CALL_MS);
    ctx.addShutdownCallback(async () => {
      clearTimeout(cap);
      await session.close();
    });

    // Speech is a handle, not a promise: a failure inside it surfaces on the
    // session's Error event and, in the worst case, the process guards above.
    session.generateReply({ instructions: openingInstruction(brief) });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    port: Number(process.env.AURA_HEALTH_PORT ?? 8082),
  }),
);
