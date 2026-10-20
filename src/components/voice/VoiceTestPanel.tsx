"use client";

import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type TranscriptionSegment,
} from "livekit-client";
import { inputClass } from "@/components/form";
import { startVoiceTest } from "@/app/voiceTestActions";
import { safeErrorMessage } from "@/lib/userError";

type OpeningOption = { id: string; label: string; companyName: string; jobTitle: string; jobDescription: string };
type Line = { id: string; who: "agent" | "you"; text: string };
type Phase = "idle" | "connecting" | "waiting" | "live" | "ended" | "error";

const DEFAULT_DETAILS = [
  "Current salary",
  "Expected salary",
  "Notice period",
  "Total years of relevant experience",
  "Reason for looking for a change",
];

/** The agent's transcript arrives two ways, depending on which agent serves the room. */
const TOPIC = "aura-transcript";

export function VoiceTestPanel({ openings }: { openings: OpeningOption[] }) {
  const [openingId, setOpeningId] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [details, setDetails] = useState(DEFAULT_DETAILS.join("\n"));
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [reply, setReply] = useState("");
  const [seconds, setSeconds] = useState(0);

  const room = useRef<Room | null>(null);
  const audioBox = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const viaTopic = useRef(false);

  useEffect(() => () => void room.current?.disconnect(), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines]);
  useEffect(() => {
    if (phase !== "live" && phase !== "waiting") return;
    const started = Date.now() - seconds * 1000;
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function pick(id: string) {
    setOpeningId(id);
    const o = openings.find((x) => x.id === id);
    if (!o) return;
    setCompanyName(o.companyName);
    setJobTitle(o.jobTitle);
    setJobDescription(o.jobDescription);
  }

  const upsert = (line: Line) =>
    setLines((prev) => {
      const at = prev.findIndex((l) => l.id === line.id);
      if (at === -1) return [...prev, line].slice(-80);
      const next = [...prev];
      next[at] = line;
      return next;
    });

  async function start() {
    setMessage(null);
    setLines([]);
    setSeconds(0);
    viaTopic.current = false;
    setPhase("connecting");
    const r = await startVoiceTest({
      candidateName,
      companyName,
      jobTitle,
      jobDescription,
      detailsToCollect: details.split("\n"),
    });
    if (!r.ok) {
      setPhase("error");
      setMessage(r.message);
      return;
    }

    const lk = new Room({ adaptiveStream: true, dynacast: true });
    room.current = lk;
    lk.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio && audioBox.current) audioBox.current.appendChild(track.attach());
    });
    lk.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
    lk.on(RoomEvent.ParticipantConnected, () => setPhase("live"));
    // The CV platform's agent: LiveKit's own transcription of both sides.
    lk.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant?: Participant) => {
      if (viaTopic.current) return;
      const mine = !participant || participant.identity === lk.localParticipant.identity;
      for (const s of segments) {
        if (!s.text.trim()) continue;
        upsert({ id: `t-${s.id}`, who: mine ? "you" : "agent", text: s.text });
      }
    });
    // The TA System's own Aura worker: its lines on a data topic.
    lk.on(RoomEvent.DataReceived, (payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; who?: string; text?: string };
        if (msg.type !== "line" || !msg.text) return;
        if (!viaTopic.current) {
          viaTopic.current = true;
          setLines([]);
        }
        upsert({ id: `d-${Date.now()}-${Math.random()}`, who: msg.who === "agent" ? "agent" : "you", text: msg.text });
      } catch {
        /* not a transcript line */
      }
    });
    lk.on(RoomEvent.Disconnected, () => {
      room.current = null;
      setPhase((p) => (p === "error" ? p : "ended"));
    });

    try {
      await lk.connect(r.url, r.token);
      await lk.startAudio();
      await lk.localParticipant.setMicrophoneEnabled(true);
      setMuted(false);
      setPhase(lk.remoteParticipants.size > 0 ? "live" : "waiting");
    } catch (e) {
      setPhase("error");
      setMessage(safeErrorMessage(e, "The call could not start. Check microphone access and try again."));
      await lk.disconnect();
    }
  }

  async function end() {
    await room.current?.disconnect();
  }

  async function toggleMute() {
    const lk = room.current;
    if (!lk) return;
    await lk.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
  }

  async function sendReply() {
    const lk = room.current;
    const text = reply.trim();
    if (!lk || !text) return;
    await lk.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "candidate_reply", text })), {
      reliable: true,
    });
    upsert({ id: `r-${Date.now()}`, who: "you", text });
    setReply("");
  }

  const inCall = phase === "connecting" || phase === "waiting" || phase === "live";
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="rounded-xl border border-rule bg-surface p-5">
        <h2 className="text-[13.5px] font-semibold">The role</h2>
        <div className="mt-4 flex flex-col gap-3.5">
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Start from an opening</span>
            <select
              id="voice-opening"
              value={openingId}
              onChange={(e) => pick(e.target.value)}
              disabled={inCall}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="">Type the role below instead</option>
              {openings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 sm:grid-cols-2">
            <label>
              <span className="mb-1.5 block text-[11.5px] text-ink-soft">Company</span>
              <input id="voice-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} disabled={inCall} className={inputClass} />
            </label>
            <label>
              <span className="mb-1.5 block text-[11.5px] text-ink-soft">Job title</span>
              <input id="voice-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} disabled={inCall} className={inputClass} />
            </label>
          </div>
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Candidate name (optional)</span>
            <input id="voice-candidate" value={candidateName} onChange={(e) => setCandidateName(e.target.value)} disabled={inCall} placeholder="Candidate" className={inputClass} />
          </label>
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Job description</span>
            <textarea
              id="voice-jd"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              disabled={inCall}
              rows={8}
              placeholder="Paste the JD — responsibilities, requirements, location, experience."
              className={`${inputClass} resize-y leading-relaxed`}
            />
          </label>
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Details for the agent to collect — one per line</span>
            <textarea
              id="voice-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              disabled={inCall}
              rows={5}
              className={`${inputClass} resize-y leading-relaxed`}
            />
          </label>
          <div className="flex items-center gap-3">
            {inCall ? (
              <button onClick={end} className="rounded-full bg-danger px-5 py-2 text-[13px] font-medium text-white hover:opacity-90">
                End call
              </button>
            ) : (
              <button onClick={start} className="rounded-full bg-brand px-5 py-2 text-[13px] font-medium text-white hover:opacity-90">
                {phase === "ended" ? "Call again" : "Start call"}
              </button>
            )}
            {inCall && phase !== "connecting" && (
              <button onClick={toggleMute} className="rounded-full border border-rule px-4 py-2 text-[12.5px] text-ink-soft hover:text-ink">
                {muted ? "Unmute" : "Mute"}
              </button>
            )}
          </div>
          {message && <p className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[12px] leading-relaxed text-danger">{message}</p>}
        </div>
      </section>

      <section className="flex min-h-[520px] flex-col rounded-xl border border-rule bg-surface">
        <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
          <div>
            <h2 className="text-[13.5px] font-semibold">Aura</h2>
            <p className="text-[11.5px] text-ink-faint">
              {phase === "idle" && "Not connected"}
              {phase === "connecting" && "Connecting…"}
              {phase === "waiting" && "Waiting for the agent to join…"}
              {phase === "live" && "On the call — speak as the candidate"}
              {phase === "ended" && "Call ended"}
              {phase === "error" && "Not connected"}
            </p>
          </div>
          {(phase === "live" || phase === "waiting") && (
            <span className="tabular inline-flex items-center gap-2 text-[12px] text-ink-soft">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
              {clock}
            </span>
          )}
        </div>
        <div ref={scroller} className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4" aria-live="polite">
          {lines.length === 0 ? (
            <p className="py-16 text-center text-[12.5px] text-ink-faint">
              {inCall ? "The conversation will appear here." : "Start a call to talk to the agent."}
            </p>
          ) : (
            lines.map((l) => (
              <div key={l.id} className={`flex ${l.who === "you" ? "justify-end" : "justify-start"}`}>
                <p
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${
                    l.who === "you" ? "bg-brand text-white" : "bg-paper text-ink"
                  }`}
                >
                  {l.text}
                </p>
              </div>
            ))
          )}
        </div>
        {inCall && phase !== "connecting" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendReply();
            }}
            className="flex gap-2 border-t border-rule px-4 py-3"
          >
            <input
              id="voice-reply"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Or type an answer…"
              className={inputClass}
            />
            <button className="rounded-full bg-brand px-4 text-[12.5px] font-medium text-white disabled:opacity-50" disabled={!reply.trim()}>
              Send
            </button>
          </form>
        )}
        <div ref={audioBox} className="hidden" />
      </section>
    </div>
  );
}
