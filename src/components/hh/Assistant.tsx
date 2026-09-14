"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { sendChatMessage } from "@/app/actions";
import type { ChatMessage } from "@/data/types";

function clock(at: number) {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The "••" mark the Figma puts beside every assistant turn. */
const Mark = () => (
  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-brand-line/50 bg-surface">
    <svg width={13} height={13} viewBox="0 0 16 16" aria-hidden="true" className="text-brand">
      <circle cx="5" cy="8" r="1.7" fill="currentColor" />
      <circle cx="11" cy="8" r="1.7" fill="currentColor" />
    </svg>
  </span>
);

/** The Figma's loading turn: the line, then two bars. */
function Generating() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div className="flex items-start gap-2.5 px-4 pb-4">
      <Mark />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-brand">Generating a response •••</p>
        <div className="mt-2 flex gap-3">
          <span className="h-px w-[130px] bg-brand/30" />
          <span className="h-px w-[40px] bg-brand/20" />
        </div>
      </div>
    </div>
  );
}

function Send() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      aria-label="Send"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      <svg width={17} height={17} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20V5M12 5l-6 6M12 5l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/**
 * The assistant — spec §8A.3, built to the Figma's light chat frame and nothing
 * more. No header, no prompt chips: the frame has a close control, the turns,
 * and the composer.
 *
 * What it did about an instruction is carried in the reply's own words rather
 * than a badge, because the design has no badge and the sentence says it anyway.
 */
export function Assistant({
  openingId,
  messages,
  initials,
}: {
  openingId: string;
  messages: ChatMessage[];
  initials: string;
}) {
  const [open, setOpen] = useState(messages.length > 0);
  const [draft, setDraft] = useState("");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open the assistant"
        className="fixed bottom-6 right-6 z-40 grid h-14 w-14 place-items-center rounded-full bg-brand text-white shadow-[0_6px_20px_rgba(22,91,66,0.30)] transition-opacity hover:opacity-90"
      >
        <svg width={22} height={22} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="5" cy="8" r="1.8" fill="currentColor" />
          <circle cx="11" cy="8" r="1.8" fill="currentColor" />
        </svg>
      </button>
    );
  }

  return (
    <aside className="fixed bottom-6 right-6 z-40 w-[400px]">
      <button
        onClick={() => setOpen(false)}
        aria-label="Close"
        className="absolute -top-3 right-0 z-10 grid h-7 w-7 place-items-center rounded-full bg-rule-strong text-[13px] leading-none text-white transition-opacity hover:opacity-80"
      >
        ✕
      </button>

      <form
        action={sendChatMessage}
        onSubmit={() => setDraft("")}
        className="flex max-h-[74vh] flex-col overflow-hidden rounded-2xl bg-paper shadow-[0_12px_40px_rgba(23,28,24,0.18)]"
      >
        <input type="hidden" name="openingId" value={openingId} />

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-2 pt-7">
          {messages.length === 0 && (
            <div className="flex items-start gap-2.5">
              <Mark />
              <p className="text-[12.5px] leading-relaxed text-brand">
                Tell me what to change about the list, or what else to look for. Re-reading the
                people already found is free; going to look for more spends one of the three rounds.
              </p>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex items-start justify-end gap-2.5">
                <div className="max-w-[78%]">
                  <p className="text-right text-[12.5px] leading-relaxed text-ink">{m.body}</p>
                  <p className="mt-1 text-right text-[10.5px] text-ink-faint">{clock(m.at)} ✓</p>
                </div>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#c9a227] text-[10px] font-semibold text-white">
                  {initials}
                </span>
              </div>
            ) : (
              <div key={m.id} className="flex items-start gap-2.5">
                <Mark />
                <div className="min-w-0 max-w-[82%]">
                  <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-brand">{m.body}</p>
                  <p className="mt-1 text-[10.5px] text-ink-faint">{clock(m.at)}</p>
                </div>
              </div>
            ),
          )}
        </div>

        <Generating />

        <div className="flex items-center gap-2 px-3 pb-3 pt-1">
          <input
            name="body"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type your message here..."
            className="min-w-0 flex-1 rounded-full border border-rule bg-surface px-4 py-3 text-[12.5px] outline-none transition-colors placeholder:text-ink-faint focus:border-brand-line"
          />
          <Send />
        </div>
      </form>
    </aside>
  );
}
