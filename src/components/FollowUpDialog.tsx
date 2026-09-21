"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sendFollowUpNowInline, stopFollowUpNowInline } from "@/app/actions";
import { ActionNote, SubmitButton, latest, submitted, useInline } from "./Submit";

/**
 * What has already been said to this candidate, and the next message.
 *
 * Pressing WhatsApp or Email on a Follow-up row used to send immediately, with
 * nothing on screen about the conversation so far: a TA could not see that the
 * candidate had replied an hour earlier, or that two reminders had already
 * gone. The buttons open this instead — every message with that person on this
 * opening, what is still missing, and Send for the channel that was pressed.
 */

type Line = {
  id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  deliveryStatus: string;
  errorMessage?: string | null;
  sentAt: number;
};

type State = {
  /** live: to the candidate; test: to the test recipient; off: stopped by the safety guard. */
  delivery?: { whatsapp: "live" | "test" | "off"; email: "live" | "test" | "off" };
  attemptCount: number;
  maxAttempts: number | null;
  nextScheduledAt: number | null;
  lastCandidateReplyAt: number | null;
  collected: { cv: boolean | null; currentSalary: boolean | null; expectedSalary: boolean | null; noticePeriod: boolean | null };
  customQuestions: string[];
  customAnswers: Record<string, string>;
};

const when = (ts: number) =>
  new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function FollowUpDialog({
  applicationId,
  openingId,
  candidateName,
  channel,
  label,
  disabled,
  title,
  className,
}: {
  applicationId: string;
  openingId: string;
  candidateName: string;
  channel: "whatsapp" | "email";
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ state: State; messages: Line[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Send and Stop answer inside the dialog, which stays open to show it and
  // the conversation re-reads (21 Sep: they closed it and answered at the top).
  const send = useInline(sendFollowUpNowInline);
  const stop = useInline(stopFollowUpNowInline);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (send.result || stop.result) setReload((n) => n + 1);
  }, [send.result, stop.result]);

  useEffect(() => {
    if (!open) return;
    if (reload === 0) setData(null);
    setError(null);
    fetch(`/api/conversation/${applicationId}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await r.text()))))
      .then(setData)
      .catch(() => setError("The conversation could not be loaded."));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, applicationId, reload]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [data]);

  const checklist = data
    ? ([
        ["CV", data.state.collected.cv],
        ["Current salary", data.state.collected.currentSalary],
        ["Expected salary", data.state.collected.expectedSalary],
        ["Notice period", data.state.collected.noticePeriod],
        ...data.state.customQuestions.map((q): [string, boolean] => [q, !!data.state.customAnswers[q]]),
      ] as [string, boolean | null][])
    : [];
  const missing = checklist.filter(([, ok]) => !ok);
  const sent = data?.state.attemptCount ?? 0;
  const max = data?.state.maxAttempts ?? 3;
  const mode = data?.state.delivery?.[channel] ?? "live";
  const channelName = channel === "whatsapp" ? "WhatsApp" : "email";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} title={title} className={className}>
        {label}
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[70] grid place-items-center bg-ink/40 p-4" onClick={() => setOpen(false)}>
            <div
              role="dialog"
              aria-label={`Messages with ${candidateName}`}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-xl"
            >
              <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
                <div>
                  <h2 className="text-[15px] font-semibold tracking-tight">{candidateName}</h2>
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">
                    {sent === 0 ? "Nothing sent yet" : `${sent} of ${max} follow-ups sent`}
                    {data?.state.lastCandidateReplyAt ? ` · they replied ${when(data.state.lastCandidateReplyAt)}` : ""}
                  </p>
                </div>
                <button onClick={() => setOpen(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint hover:bg-paper hover:text-ink">
                  ✕
                </button>
              </div>

              {missing.length > 0 && (
                <p className="border-b border-rule bg-paper/60 px-5 py-2.5 text-[12px] text-ink-soft">
                  Still needed: {missing.map(([label]) => label).join(", ")}
                </p>
              )}

              {mode !== "live" && (
                <p className="border-b border-warn/30 bg-warn-soft px-5 py-2.5 text-[12px] leading-relaxed text-warn">
                  {mode === "off"
                    ? `Test system: ${channelName} to candidates is switched off. Messages are recorded here but not sent, and are not counted as follow-ups.`
                    : `Test system: ${channelName} goes to the test ${channel === "whatsapp" ? "number" : "address"}, not to ${candidateName}.`}
                </p>
              )}
              <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                {error && <p className="py-10 text-center text-[12.5px] text-danger">{error}</p>}
                {!data && !error && <p className="py-10 text-center text-[12.5px] text-ink-faint">Reading the conversation…</p>}
                {data?.messages.length === 0 && (
                  <p className="py-10 text-center text-[12.5px] text-ink-faint">
                    Nothing has been sent to {candidateName} on this opening yet.
                  </p>
                )}
                {data?.messages.map((m) => {
                  const out = m.direction === "outbound";
                  const failed = m.deliveryStatus === "failed";
                  return (
                    <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${out ? "bg-brand-soft" : "bg-paper"}`}>
                        <p className="mb-1 text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
                          {m.channel} · {out ? "Career141" : candidateName} · {when(m.sentAt)}
                          {failed ? (blockedByTestMode(m.errorMessage) ? " · not sent (test mode)" : " · not delivered") : ""}
                        </p>
                        {m.subject && <p className="text-[12.5px] font-medium">{m.subject}</p>}
                        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{withoutSendNote(m.body)}</p>
                        {failed && m.errorMessage && <DeliveryProblem text={m.errorMessage} />}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-5 py-3.5">
                <form onSubmit={(e) => send.run(submitted(e).formData)}>
                  <input type="hidden" name="appId" value={applicationId} />
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="channel" value={channel} />
                  <SubmitButton
                    busy={send.pending}
                    locked={send.pending || stop.pending}
                    disabled={sent >= max}
                    pendingLabel="Sending…"
                    className="rounded-full bg-brand px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-rule-strong"
                  >
                    {mode === "off"
                      ? `Record ${channelName} (not sent)`
                      : mode === "test"
                        ? `Send to the test ${channel === "whatsapp" ? "number" : "address"}`
                        : sent === 0
                          ? `Send the first ${channelName}`
                          : sent >= max
                            ? `All ${max} sent`
                            : `Send follow-up ${sent + 1} of ${max}`}
                  </SubmitButton>
                </form>
                {sent > 0 && (
                  <form
                    onSubmit={(e) => {
                      if (!window.confirm(`Stop following up ${candidateName}? No more reminders will go.`)) {
                        e.preventDefault();
                        return;
                      }
                      stop.run(submitted(e).formData);
                    }}
                  >
                    <input type="hidden" name="appId" value={applicationId} />
                    <input type="hidden" name="openingId" value={openingId} />
                    <SubmitButton
                      busy={stop.pending}
                      locked={send.pending || stop.pending}
                      pendingLabel="Stopping…"
                      tone="dark"
                      className="text-[12.5px] text-ink-faint hover:text-ink disabled:opacity-60"
                    >
                      Stop follow-up
                    </SubmitButton>
                  </form>
                )}
                <ActionNote result={latest(send.result, stop.result)} className="w-full" />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** A message the safety guard stopped, as opposed to one the network lost. */
function blockedByTestMode(error: string | null | undefined): boolean {
  return /test mode: blocked/i.test(error ?? "");
}

/** "[reengagement template not sent] Test mode: …" — the sender's note, not the message. */
function withoutSendNote(body: string): string {
  return body.replace(/^\[[^\]]*not sent\]\s*Test mode:[^\n]*\n?/i, "").trim() || body;
}

/**
 * Why a message did not go, in one line. The safety guard's own wording names
 * environment variables; that stays behind Details for whoever administers it.
 */
function DeliveryProblem({ text }: { text: string }) {
  if (!blockedByTestMode(text)) return <p className="mt-1 text-[11px] leading-snug text-danger">{text}</p>;
  return (
    <details className="mt-1 text-[11px] leading-snug text-warn">
      <summary>Not sent — messages to candidates are switched off on this system.</summary>
      <p className="mt-1 text-ink-faint">{text}</p>
    </details>
  );
}
