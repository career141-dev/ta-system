"use client";

import { useEffect, useRef, useState } from "react";
import { logCall } from "@/app/actions";
import { inputClass } from "./form";
import { SubmitButton } from "./Submit";

const KINDS = [
  { value: "pre_interview", label: "Pre-interview — confirming attendance" },
  { value: "post_interview", label: "Post-interview — how it went" },
  { value: "post_offer", label: "Post-offer — accepted, negotiating, joining date" },
  { value: "ad_hoc", label: "Other" },
];

const OUTCOMES = [
  { value: "reached", label: "Reached them" },
  { value: "no_answer", label: "No answer" },
  { value: "rescheduled", label: "Rescheduled" },
  { value: "declined", label: "Declined" },
];

const chev = (
  <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
    <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Spec §6A — logging a call. A `pre_interview` call marked "reached" is what
 * clears the TA Lead escalation, so this form is the thing that makes §12.2a
 * work rather than just display.
 */
export function CallLogForm({
  applicationId,
  openingId,
  defaultKind = "ad_hoc",
}: {
  applicationId: string;
  openingId: string;
  defaultKind?: string;
}) {
  const [kind, setKind] = useState(defaultKind);
  const [outcome, setOutcome] = useState("reached");
  const [body, setBody] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const draftCheckedRef = useRef(false);

  useEffect(() => {
    if (draftCheckedRef.current) return;
    draftCheckedRef.current = true;
    try {
      const raw = localStorage.getItem(`call-log-draft:${applicationId}`);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (draft && typeof draft === "object") {
        if (typeof draft.body === "string" && draft.body.trim().length > 0) {
          setBody(draft.body);
          if (typeof draft.kind === "string") setKind(draft.kind);
          if (typeof draft.outcome === "string") setOutcome(draft.outcome);
          setDraftRestored(true);
        }
      }
    } catch {
      // Ignore storage errors
    }
  }, [applicationId]);

  useEffect(() => {
    if (!draftCheckedRef.current) return;
    const timer = setTimeout(() => {
      try {
        if (body.trim().length > 0 || kind !== defaultKind || outcome !== "reached") {
          localStorage.setItem(
            `call-log-draft:${applicationId}`,
            JSON.stringify({ kind, outcome, body, updatedAt: Date.now() })
          );
        } else {
          localStorage.removeItem(`call-log-draft:${applicationId}`);
          setDraftRestored(false);
        }
      } catch {
        // Ignore storage errors
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [body, kind, outcome, applicationId, defaultKind]);

  const discardDraft = () => {
    try {
      localStorage.removeItem(`call-log-draft:${applicationId}`);
    } catch {}
    setKind(defaultKind);
    setOutcome("reached");
    setBody("");
    setDraftRestored(false);
  };

  const selectClass = `${inputClass} cursor-pointer appearance-none pr-10`;
  return (
    <form
      action={logCall}
      onSubmit={() => {
        try {
          localStorage.removeItem(`call-log-draft:${applicationId}`);
        } catch {}
      }}
      className="rounded-xl border border-rule bg-paper/50 p-5"
    >
      <input type="hidden" name="appId" value={applicationId} />
      <input type="hidden" name="openingId" value={openingId} />
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold">Log a call</p>
        {draftRestored && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-800 dark:text-amber-200">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span>Draft restored</span>
            <button
              type="button"
              onClick={discardDraft}
              className="ml-1 font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
            >
              Discard
            </button>
          </div>
        )}
      </div>
      <div className="mt-3.5 grid grid-cols-[minmax(0,1fr)] gap-3.5 sm:grid-cols-2">
        <label>
          <span className="mb-1.5 block text-[11.5px] text-ink-soft">Which call</span>
          <div className="relative">
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={selectClass}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
            {chev}
          </div>
        </label>
        <label>
          <span className="mb-1.5 block text-[11.5px] text-ink-soft">Outcome</span>
          <div className="relative">
            <select name="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={selectClass}>
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {chev}
          </div>
        </label>
      </div>
      <label className="mt-3.5 block">
        <span className="mb-1.5 block text-[11.5px] text-ink-soft">What they said</span>
        <textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          required
          placeholder="In their words where you can — it goes in the end-of-day email as written"
          className={`${inputClass} leading-relaxed`}
        />
      </label>
      <div className="mt-4 flex items-center gap-4">
        <SubmitButton
          pendingLabel="Saving…"
          className="rounded-full bg-brand px-5 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          Save call
        </SubmitButton>
        <span className="text-[11.5px] text-ink-faint">
          A pre-interview call marked &ldquo;reached&rdquo; clears the lead&rsquo;s escalation.
        </span>
      </div>
    </form>
  );
}
