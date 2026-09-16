"use client";

import { useEffect, useRef, useState } from "react";
import { CONSENT_TEXT } from "@/lib/intake";

type State = "idle" | "consent" | "recording" | "saving" | "saved" | "denied";

export interface SavedRecording {
  /** Where the audio is stored; null when storing failed but a transcript came back. */
  key: string | null;
  durationMs: number;
  consentText: string;
}

/**
 * Spec D3 — records the laptop microphone with the call on speaker. No
 * telephony, no meeting integration.
 *
 * Spec §5.3 / Q1 — consent is given at the moment record is pressed. The button
 * is deliberately two-step: the disclosure has to be acknowledged before the
 * microphone is even requested, and the wording shown is stored with the
 * acknowledgement so a later revision never rewrites what was agreed to.
 *
 * The recording is transcribed (OpenAI, lib/transcribe) and the words are
 * handed to `onTranscript`, which adds them to the notes box for the person to
 * read and correct before saving.
 *
 * Every button here is type="button": the recorder sits inside the opening
 * form, and a button without a type submits its form — pressing Stop used to
 * send the half-filled opening and throw the recording away.
 */
export function BriefRecorder({
  onSaved,
  onTranscript,
  label = "Record the brief",
}: {
  onSaved?: (v: SavedRecording) => void;
  onTranscript?: (text: string) => void;
  label?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const [transcriptNote, setTranscriptNote] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function begin() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("saving");
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        const durationMs = Date.now() - started.current;
        const body = new FormData();
        body.append("audio", blob, "brief.webm");
        body.append("durationMs", String(durationMs));
        try {
          const res = await fetch("/api/recording", { method: "POST", body });
          const json = (await res.json().catch(() => ({}))) as {
            key?: string | null;
            transcript?: string | null;
            transcriptProblem?: string | null;
            storageProblem?: string | null;
            error?: string;
          };
          // "Saved" only when the server says so and handed back a key or the
          // words — a failed upload used to be reported as saved (audit finding 42).
          if (!res.ok || (!json.key && !json.transcript)) {
            setError(
              json.error === "size"
                ? "That recording is too long to store. Your notes are unaffected."
                : json.error === "signed_out"
                  ? "Your session has ended. Sign in again, then record."
                  : json.error === "not_allowed"
                    ? "Your account cannot record a brief."
                    : `The recording could not be saved${res.status ? ` (${res.status})` : ""}. Your notes are unaffected.`,
            );
            setState("idle");
            return;
          }
          onSaved?.({ key: json.key ?? null, durationMs, consentText: CONSENT_TEXT });
          if (json.transcript) onTranscript?.(json.transcript);
          setTranscriptNote(
            json.transcript
              ? `Transcribed and added to the notes${json.storageProblem ? " (the audio itself could not be stored)" : ""}. Read it through and correct anything misheard before saving.`
              : json.transcriptProblem ?? "Type the key points below.",
          );
          setState("saved");
        } catch {
          setError("The recording could not be saved. Your notes are unaffected.");
          setState("idle");
        }
      };
      mr.start();
      recorder.current = mr;
      started.current = Date.now();
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState("recording");
    } catch {
      setState("denied");
    }
  }

  function stop() {
    if (timer.current) clearInterval(timer.current);
    recorder.current?.stop();
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  if (state === "consent") {
    return (
      <div className="rounded-xl border border-rule bg-surface p-6">
        <h3 className="text-[14px] font-semibold">Before recording starts</h3>
        <p className="mt-2.5 max-w-[62ch] text-[13px] leading-[1.7] text-ink-soft">{CONSENT_TEXT}</p>
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={begin}
            className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
          >
            Everyone has agreed — start recording
          </button>
          <button
            type="button"
            onClick={() => setState("idle")}
            className="text-[13px] text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-rule bg-surface px-6 py-5">
        <span className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
          <span className="tabular text-[15px] font-semibold">{mmss}</span>
        </span>
        <span className="text-[12.5px] text-ink-soft">Recording — put the call on speaker</span>
        <button
          type="button"
          onClick={stop}
          className="ml-auto rounded-full border border-rule-strong px-4 py-2 text-[12.5px] font-medium text-ink hover:border-ink-faint"
        >
          Stop
        </button>
      </div>
    );
  }

  if (state === "saving") {
    return (
      <div className="rounded-xl border border-rule bg-surface px-6 py-5 text-[13px] text-ink-soft">
        Saving and transcribing the recording… this takes a few seconds per minute recorded.
      </div>
    );
  }

  if (state === "saved") {
    return (
      <div className="rounded-xl border border-rule bg-surface px-6 py-5">
        <p className="text-[13px]">
          Recording saved · <span className="tabular">{mmss}</span>
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-faint">{transcriptNote}</p>
        <button
          type="button"
          onClick={() => setState("consent")}
          className="mt-3 text-[12.5px] font-medium text-accent hover:underline"
        >
          Record more
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-rule bg-surface px-6 py-5">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => setState("consent")}
          className="flex items-center gap-2.5 rounded-full border border-brand-line px-4 py-2 text-[13px] font-medium text-brand hover:bg-brand-soft"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-danger" />
          {label}
        </button>
        <p className="text-[12.5px] text-ink-soft">
          Captures this laptop&rsquo;s microphone — put the call on speaker. What is said is typed into the notes for you.
        </p>
      </div>
      {state === "denied" && (
        <p className="mt-3 text-[12.5px] text-danger">
          The browser blocked microphone access. Allow it in the address bar, or just type the notes
          below.
        </p>
      )}
      {error && <p className="mt-3 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}
