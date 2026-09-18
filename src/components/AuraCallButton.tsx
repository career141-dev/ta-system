"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrack, type TranscriptionSegment } from "livekit-client";
import { completeWebCall, startWebCall, type CallLine } from "@/app/voiceActions";

/**
 * Call a candidate with Aura, the screening voice agent, in a pop-up.
 *
 * Pressing Call opens the window and starts a call room for this candidate.
 * Aura (voice-agent/) is sent into it with the opening's details: it says hi,
 * that it is calling from Career141 about the role, then asks current salary,
 * expected salary, notice period and the opening's own questions. Every line
 * it hears or says appears here as the call goes. When the call ends the
 * transcript goes back to the backend, which reads the answers into the
 * candidate's record.
 *
 * There is no phone line (SIP trunk) yet, so the call is held in the browser:
 * whoever is at this microphone is the candidate.
 */

type Phase = "idle" | "connecting" | "waiting" | "live" | "saving" | "ended" | "error";

const TOPIC = "aura-transcript";

export function AuraCallButton({
  applicationId,
  openingId,
  candidateName,
  roleTitle,
  compact = false,
}: {
  applicationId: string;
  openingId: string;
  candidateName: string;
  roleTitle: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          compact
            ? "rounded-full border border-rule px-3 py-[5px] text-[12px] font-medium text-ink hover:bg-tag"
            : "rounded-full bg-brand px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90"
        }
      >
        {compact ? "Call" : "Call with Aura"}
      </button>
      {open && (
        <AuraCallDialog
          applicationId={applicationId}
          openingId={openingId}
          candidateName={candidateName}
          roleTitle={roleTitle}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AuraCallDialog({
  applicationId,
  openingId,
  candidateName,
  roleTitle,
  onClose,
}: {
  applicationId: string;
  openingId: string;
  candidateName: string;
  roleTitle: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<CallLine[]>([]);
  const [muted, setMuted] = useState(false);
  const [mounted, setMounted] = useState(false);
  const room = useRef<Room | null>(null);
  const callId = useRef<string | null>(null);
  const startedAt = useRef(0);
  const heard = useRef<CallLine[]>([]);
  const audioBox = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const inCall = phase === "connecting" || phase === "waiting" || phase === "live";

  useEffect(() => {
    setMounted(true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      void room.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  async function start() {
    setMessage(null);
    setLines([]);
    heard.current = [];
    setPhase("connecting");
    const r = await startWebCall(applicationId, openingId);
    if (!r.ok) {
      setPhase("error");
      setMessage(r.message);
      return;
    }
    callId.current = r.aiCallId;
    startedAt.current = Date.now();

    const lk = new Room({ adaptiveStream: true, dynacast: true });
    room.current = lk;
    lk.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio && audioBox.current) audioBox.current.appendChild(track.attach());
    });
    lk.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
    lk.on(RoomEvent.ParticipantConnected, () => setPhase("live"));
    lk.on(RoomEvent.DataReceived, (payload: Uint8Array, _p?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; who?: string; text?: string };
        if (msg.type !== "line" || !msg.text || (msg.who !== "agent" && msg.who !== "candidate")) return;
        const line: CallLine = { who: msg.who, text: msg.text };
        heard.current = [...heard.current, line];
        setLines(heard.current.slice(-60));
      } catch {
        /* not a transcript line */
      }
    });
    // The CV platform's agent sends no lines on TOPIC; LiveKit's own
    // transcription carries both sides instead. Used only until a TOPIC line
    // arrives, so the TA System's worker is not heard twice.
    const segments = new Map<string, CallLine>();
    lk.on(RoomEvent.TranscriptionReceived, (parts: TranscriptionSegment[], who?: Participant) => {
      if (heard.current.length > segments.size) return;
      const mine = !who || who.identity === lk.localParticipant.identity;
      for (const s of parts) {
        if (!s.final || !s.text.trim()) continue;
        segments.set(s.id, { who: mine ? "candidate" : "agent", text: s.text });
      }
      heard.current = [...segments.values()];
      setLines(heard.current.slice(-60));
    });
    lk.on(RoomEvent.Disconnected, () => void finish("Call ended"));

    try {
      await lk.connect(r.url, r.token);
      await lk.startAudio();
      await lk.localParticipant.setMicrophoneEnabled(true);
      setPhase(lk.remoteParticipants.size > 0 ? "live" : "waiting");
    } catch (e) {
      setMessage(`Could not join the call: ${(e as Error).message}. Is LiveKit running?`);
      await finish("The browser could not join the call room", true);
    }
  }

  async function finish(reason: string, failed = false) {
    const id = callId.current;
    callId.current = null;
    if (!id) return;
    setPhase("saving");
    const r = await completeWebCall({
      aiCallId: id,
      openingId,
      durationSeconds: (Date.now() - startedAt.current) / 1000,
      lines: heard.current,
      reason,
    });
    setPhase(failed ? "error" : "ended");
    if (!failed) {
      setMessage(
        r.answered
          ? "Call saved. The answers are being read into the candidate's record — they show on the Call tab in a few seconds."
          : heard.current.length === 0
            ? "Aura never joined the call, so nothing was saved. Is the Aura voice agent running?"
            : "Nobody answered, so the call is saved as no answer.",
      );
    }
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

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-6 sm:py-10" role="dialog" aria-modal="true" aria-label={`Call ${candidateName}`}>
      <div aria-hidden="true" className="fixed inset-0 bg-[#0b1a12]/45" onClick={() => !inCall && phase !== "saving" && onClose()} />
      <div className="relative flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-rule bg-paper shadow-[0_24px_60px_rgba(11,26,18,.22)]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule bg-surface px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">Call {candidateName}</h2>
            <p className="mt-0.5 truncate text-[12px] text-ink-faint">
              Aura · {roleTitle} ·{" "}
              {phase === "idle" && "ready"}
              {phase === "connecting" && "connecting…"}
              {phase === "waiting" && "waiting for Aura to join…"}
              {phase === "live" && "in call"}
              {phase === "saving" && "saving the call…"}
              {phase === "ended" && "call ended"}
              {phase === "error" && "not connected"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={inCall || phase === "saving"}
            className="rounded-full px-2.5 py-1 text-[18px] leading-none text-ink-faint hover:text-ink disabled:opacity-30"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Aura says hi, that it is calling from Career141 about the {roleTitle} role, then asks current salary, expected
            salary, notice period and this opening&apos;s own questions. What the candidate tells it is saved to their
            record when the call ends. No phone line yet: the call runs in this browser, so whoever is at this microphone
            is the candidate.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {!inCall ? (
              <button
                type="button"
                onClick={start}
                disabled={phase === "saving"}
                className="rounded-full bg-brand px-5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                {phase === "ended" || phase === "error" ? "Call again" : "Start call"}
              </button>
            ) : (
              <>
                <button type="button" onClick={hangUp} className="rounded-full bg-danger px-5 py-2 text-[13px] font-medium text-white hover:opacity-90">
                  End call
                </button>
                <button type="button" onClick={toggleMute} className="text-[12.5px] text-ink-soft hover:text-ink">
                  {muted ? "Unmute" : "Mute"}
                </button>
              </>
            )}
          </div>

          {message && (
            <p className={`text-[12.5px] leading-relaxed ${phase === "error" ? "text-danger" : "text-ink-soft"}`}>{message}</p>
          )}

          {lines.length > 0 && (
            <div ref={scroller} className="max-h-[320px] overflow-y-auto rounded-lg border border-rule bg-surface px-3.5 py-2.5">
              {lines.map((l, i) => (
                <p key={i} className="py-1 text-[12.5px] leading-relaxed">
                  <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    {l.who === "agent" ? "Aura" : "Candidate"}
                  </span>
                  {l.text}
                </p>
              ))}
            </div>
          )}
        </div>
        <div ref={audioBox} hidden />
      </div>
    </div>,
    document.body,
  );
}
