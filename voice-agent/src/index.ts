// voice-agent/src/index.ts
//
// Aura, the TA System's screening call agent — a LiveKit Agents worker on one
// OpenAI Realtime model (gpt-realtime-2.1-mini) that hears, thinks and speaks.
// 24 Sep: replaced the Deepgram Nova → GPT-4o-mini → Deepgram Aura chain, so
// the whole call runs on the one OPENAI_API_KEY and there is no Deepgram key.
//
// It registers under an agent name, so it joins only rooms the TA System
// dispatches it to (src/app/voiceActions.ts), never every room on the server.
// It reads the call brief from the room metadata (convex/ta/voice.ts), opens
// the call, works the checklist, and sends every finished line to the call
// window on the `aura-transcript` topic. The window hands that transcript back
// when the call ends, and the answers are read from it.
//
// Run locally:  cd voice-agent && npm install && npm run dev

import { type JobContext, ServerOptions, cli, defineAgent, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
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
// OpenAI directly, as the CV platform's agent does. There is no OpenRouter
// fallback on purpose: that account serves only deepseek-v4-flash, so falling
// back to `openai/gpt-4o-mini` there would turn a key problem into a call where
// Aura never speaks.
const OPENAI_API_KEY = need("OPENAI_API_KEY");
// Overridable so a renamed model or a new voice is a config change, not a rebuild.
const REALTIME_MODEL = (process.env.AURA_REALTIME_MODEL ?? "").trim() || "gpt-realtime-2.1-mini";
const REALTIME_VOICE = (process.env.AURA_REALTIME_VOICE ?? "").trim() || "marin";

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * How Aura takes turns.
 *
 * 24 Sep, first: with OpenAI's server VAD, LiveKit hard-cancelled Aura's reply
 * the instant the server heard any sound — a cough, an "mm-hmm", her own voice
 * echoing back — and the model started a fresh one, so testers heard half a
 * sentence. Moving turn-taking to a local Silero VAD fixed that but made it
 * worse: Silero hears the raw line, before any noise reduction, so hiss or
 * echo kept it sure the candidate was still talking. Aura kept listening and
 * answered late or not at all.
 *
 * So OpenAI's server VAD decides turns again (it hears noise-reduced audio,
 * and was quick), and nothing may cut Aura off: interrupt_response is off on
 * the server and interruptions are off in the session. While she speaks, the
 * line is not sent on at all (LiveKit drops audio during speech that cannot
 * be interrupted), so her own echo cannot become a "reply" either. Her
 * sentences are one or two short lines, so the candidate never waits long.
 * If she starts talking over pauses, raise AURA_SILENCE_MS; if room noise
 * starts turns, raise AURA_VAD_THRESHOLD.
 */
/**
 * 2 Oct: the candidate can talk over Aura again. With interruptions off she read
 * out a long answer to the end while the candidate spoke, and only then took in
 * what they had said — callers could not stop her or correct her, and she moved
 * on as if they had said nothing. AURA_INTERRUPTIONS=off puts the old behaviour back.
 *
 * To keep the 24 Sep problem (a cough, an "mm-hmm", her own echo cutting her off)
 * from returning: the server VAD threshold is higher while interruptions are on
 * (0.6), and LiveKit resumes her sentence if no words follow the sound. She also
 * speaks a little slower (AURA_SPEED, default 0.92) and waits a little longer
 * before answering (AURA_SILENCE_MS, default 600), because she was too quick for
 * callers to follow.
 */
const INTERRUPTIONS = (process.env.AURA_INTERRUPTIONS ?? "on").trim().toLowerCase() !== "off";
const SILENCE_MS = num("AURA_SILENCE_MS", INTERRUPTIONS ? 600 : 400);
const SPEED = Math.min(1.5, Math.max(0.5, num("AURA_SPEED", 0.92)));
const TURN_DETECTION = {
  type: "server_vad",
  threshold: num("AURA_VAD_THRESHOLD", INTERRUPTIONS ? 0.6 : 0.5),
  // Keeps the first syllable of an answer.
  prefix_padding_ms: 300,
  silence_duration_ms: SILENCE_MS,
  create_response: true,
  interrupt_response: INTERRUPTIONS,
} as const;

/**
 * A provider hiccup must not end the call.
 *
 * Node 22 exits the process on an unhandled rejection, and a call is full of
 * promises nobody awaits (speech, playout). Without these the worker died
 * mid-call and the window just went quiet.
 */
process.on("uncaughtException", (err) => console.error("[Aura] Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.warn("[Aura] Unhandled promise rejection:", reason));

function textOf(item: any): string {
  if (!item) return "";
  if (typeof item.textContent === "string") return item.textContent;
  const content = Array.isArray(item.content) ? item.content : [item.content];
  return content.filter((c: unknown) => typeof c === "string").join(" ");
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const brief = readBrief(ctx.room.metadata);
    console.info(
      `[Aura] Call starting [room=${ctx.room.name}] [role=${brief.jobTitle}] [items=${brief.detailsToCollect.length}] [model=${REALTIME_MODEL}] [voice=${REALTIME_VOICE}] [silence=${SILENCE_MS}ms] [interruptions=${INTERRUPTIONS ? "on" : "off"}] [speed=${SPEED}]`,
    );

    // OpenAI decides when the candidate has finished (TURN_DETECTION above);
    // minimal reasoning keeps the first word fast. Candidate speech is
    // transcribed by OpenAI too, for the call transcript. Noise reduction is
    // applied before OpenAI's VAD, so room noise does not hold a turn open.
    const llm = new openai.realtime.RealtimeModel({
      apiKey: OPENAI_API_KEY,
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      reasoning: { effort: "minimal" },
      speed: SPEED,
      turnDetection: TURN_DETECTION,
      inputAudioNoiseReduction: { type: "near_field" },
    });

    const session = new voice.AgentSession({
      llm,
      // The browser already cancels its own echo; three seconds of warm-up only
      // stopped the candidate interrupting at the start of every answer.
      aecWarmupDuration: 0,
      // LiveKit logs a startup warning that interruptions "cannot be false"
      // with server-side turn detection; here that is the point (see above).
      turnHandling: {
        turnDetection: "realtime_llm",
        interruption: INTERRUPTIONS
          ? { enabled: true, falseInterruptionTimeout: 1500, resumeFalseInterruption: true }
          : { enabled: false },
      },
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
    // How long each reply took to start sounding — the number to watch when a
    // call feels laggy.
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (e: any) => {
      const m = e?.metrics;
      if (m?.type === "realtime_model_metrics" && m.ttftMs >= 0) console.info(`[Aura] reply first audio in ${Math.round(m.ttftMs)} ms`);
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
      agent: new voice.Agent({ instructions: systemPrompt(brief), llm }),
      room: ctx.room,
      record: false,
    });

    const cap = setTimeout(() => {
      console.warn(`[Aura] Call cap reached [room=${ctx.room.name}]`);
      // There is no separate TTS for session.say(); the realtime model speaks it.
      session.generateReply({
        instructions:
          'Say exactly this and nothing else: "We\'re out of time for this call, so I\'ll let you go. Thank you, and the Career141 team will be in touch."',
      });
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
