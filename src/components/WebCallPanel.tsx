"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Room, RoomEvent, Track, type RemoteTrack, type TranscriptionSegment, type Participant } from "livekit-client";
import { endWebCall, startWebCall } from "@/app/voiceActions";
import { safeErrorMessage } from "@/lib/userError";

/**
 * Start an AI screening call and hold it here, in the browser.
 *
 * The voice agent joins the room and asks: is the candidate still interested
 * in the role they were shortlisted for, their current salary, expected salary
 * and notice period (and the opening's own questions). What it confirms is
 * saved by the backend and shows up in the results below once the call ends.
 *
 * Until a SIP trunk exists, whoever is at this microphone is "the candidate" —
 * the TA testing the agent, or the candidate sat with them.
 */

type Phase = "idle" | "connecting" | "waiting" | "live" | "ended" | "error";

interface Line {
  id: string;
  who: "agent" | "you";
  text: string;
  final: boolean;
}

export function WebCallPanel({ applicationId, openingId }: { applicationId: string; openingId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const room = useRef<Room | null>(null);
  const callId = useRef<string | null>(null);
  const audioBox = useRef<HTMLDivElement | null>(null);

  // Leaving the page ends the call rather than leaving a room open.
  useEffect(() => () => void room.current?.disconnect(), []);

  async function start() {
    setMessage(null);
    setLines([]);
    setPhase("connecting");
    const r = await startWebCall(applicationId, openingId);
    if (!r.ok) {
      setPhase("error");
      setMessage(r.message);
      return;
    }
    callId.current = r.aiCallId;

    const lk = new Room({ adaptiveStream: true, dynacast: true });
    room.current = lk;

    lk.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio && audioBox.current) {
        const el = track.attach();
        audioBox.current.appendChild(el);
      }
    });
    lk.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
    lk.on(RoomEvent.ParticipantConnected, () => setPhase("live"));
    lk.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant?: Participant) => {
      const who: Line["who"] = participant && participant.identity === lk.localParticipant.identity ? "you" : "agent";
      setLines((prev) => {
        const next = [...prev];
        for (const s of segments) {
          const i = next.findIndex((l) => l.id === s.id);
          const line = { id: s.id, who, text: s.text, final: s.final };
          if (i >= 0) next[i] = line;
          else next.push(line);
        }
        return next.slice(-40);
      });
    });
    lk.on(RoomEvent.Disconnected, () => {
      setPhase((p) => (p === "error" ? p : "ended"));
      void finish("Call ended");
    });

    try {
      await lk.connect(r.url, r.token);
      await lk.startAudio();
      await lk.localParticipant.setMicrophoneEnabled(true);
      setPhase(lk.remoteParticipants.size > 0 ? "live" : "waiting");
    } catch (e) {
      setPhase("error");
      setMessage(safeErrorMessage(e, "The call could not start. Check microphone access and try again."));
      await finish("Browser could not join the room");
    }
  }

  async function finish(reason: string) {
    const id = callId.current;
    callId.current = null;
    if (!id) return;
    // A moment for the agent's own "finalize" to land first; if it did, this is a no-op.
    await new Promise((res) => setTimeout(res, 2500));
    await endWebCall(id, openingId, reason);
    router.refresh();
  }

  async function hangUp() {
    await room.current?.disconnect();
  }

  async function toggleMute() {
    const lk = room.current;
    if (!lk) return;
    await lk.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
  }

  const inCall = phase === "connecting" || phase === "waiting" || phase === "live";

  return (
    <div className="rounded-xl border border-rule bg-paper p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">AI screening call</h3>
        <span className="text-[11.5px] text-ink-faint">
          {phase === "connecting" && "connecting…"}
          {phase === "waiting" && "waiting for the agent to join…"}
          {phase === "live" && "in call"}
          {phase === "ended" && "call ended — results below"}
          {phase === "idle" && "in the browser · no phone line needed"}
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
        The agent confirms the role they were shortlisted for, then asks current salary, expected salary and notice
        period. Answers it confirms are saved to the candidate.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!inCall ? (
          <button
            onClick={start}
            className="rounded-full bg-brand px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90"
          >
            {phase === "ended" || phase === "error" ? "Start another call" : "Start AI call"}
          </button>
        ) : (
          <>
            <button
              onClick={hangUp}
              className="rounded-full bg-danger px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90"
            >
              End call
            </button>
            <button onClick={toggleMute} className="text-[12.5px] text-ink-soft hover:text-ink">
              {muted ? "Unmute" : "Mute"}
            </button>
          </>
        )}
      </div>

      {message && <p className="mt-3 text-[12px] text-danger">{message}</p>}

      {lines.length > 0 && (
        <div className="mt-4 max-h-[280px] overflow-y-auto rounded-lg border border-rule bg-surface px-3 py-2">
          {lines.map((l) => (
            <p key={l.id} className={`py-0.5 text-[12.5px] leading-relaxed ${l.final ? "" : "text-ink-faint"}`}>
              <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                {l.who === "agent" ? "Agent" : "You"}
              </span>
              {l.text}
            </p>
          ))}
        </div>
      )}
      <div ref={audioBox} hidden />
    </div>
  );
}
