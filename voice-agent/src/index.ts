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
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ?? "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) throw new Error("[Aura] Missing OPENAI_API_KEY or OPENROUTER_API_KEY");

type UserData = { vad?: VAD };

function textOf(item: any): string {
  if (!item) return "";
  if (typeof item.textContent === "string") return item.textContent;
  const content = Array.isArray(item.content) ? item.content : [item.content];
  return content.filter((c: unknown) => typeof c === "string").join(" ");
}

export default defineAgent<UserData>({
  prewarm: async (proc: JobProcess<UserData>) => {
    proc.userData.vad = await silero.VAD.load({ minSilenceDuration: 350, minSpeechDuration: 100 });
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
    });
    const llm = OPENAI_API_KEY
      ? new openai.LLM({ apiKey: OPENAI_API_KEY, model: "gpt-4o-mini", temperature: 0.3 })
      : new openai.LLM({
          apiKey: OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1",
          model: "openai/gpt-4o-mini",
          temperature: 0.3,
        });
    const tts = new deepgram.TTS({ apiKey: DEEPGRAM_API_KEY, model: "aura-2-asteria-en", sampleRate: 24_000 });

    const session = new voice.AgentSession({ vad, stt, llm, tts });

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

    await ctx.waitForParticipant();
    await session.start({ agent: new voice.Agent({ instructions: systemPrompt(brief) }), room: ctx.room });

    const cap = setTimeout(() => {
      console.warn(`[Aura] Call cap reached [room=${ctx.room.name}]`);
      session.say("We're out of time for this call, so I'll let you go. Thank you, and the Career141 team will be in touch.");
      setTimeout(() => void ctx.deleteRoom().finally(() => ctx.shutdown("call_cap")), 8000);
    }, MAX_CALL_MS);
    ctx.addShutdownCallback(async () => {
      clearTimeout(cap);
      await session.close();
    });

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
