"use client";

import { logCall } from "@/app/actions";
import { inputClass } from "./form";

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
  const selectClass = `${inputClass} cursor-pointer appearance-none pr-10`;
  return (
    <form action={logCall} className="rounded-xl border border-rule bg-paper/50 p-5">
      <input type="hidden" name="appId" value={applicationId} />
      <input type="hidden" name="openingId" value={openingId} />
      <p className="mb-3.5 text-[13px] font-semibold">Log a call</p>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <label>
          <span className="mb-1.5 block text-[11.5px] text-ink-soft">Which call</span>
          <div className="relative">
            <select name="kind" defaultValue={defaultKind} className={selectClass}>
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
            <select name="outcome" defaultValue="reached" className={selectClass}>
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
          rows={3}
          required
          placeholder="In their words where you can — it goes in the end-of-day email as written"
          className={`${inputClass} leading-relaxed`}
        />
      </label>
      <div className="mt-4 flex items-center gap-4">
        <button className="rounded-full bg-brand px-5 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90">
          Save call
        </button>
        <span className="text-[11.5px] text-ink-faint">
          A pre-interview call marked &ldquo;reached&rdquo; clears the lead&rsquo;s escalation.
        </span>
      </div>
    </form>
  );
}
