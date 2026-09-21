"use client";

import { useEffect, useRef, useState } from "react";
import { addOpeningQuestionInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";
import { inputClass } from "./form";

/**
 * "Ask a question", on the Follow-up page (plan 3.4, 21 Sep).
 *
 * Adds a question to what this opening's follow-up asks everyone. The list
 * already asked is shown first, so nothing goes out twice.
 */
export function AskQuestion({
  openingId,
  standard,
  custom,
  canAsk,
}: {
  openingId: string;
  /** Asked on every opening: CV, salaries, notice… */
  standard: string[];
  /** Asked on this one. */
  custom: string[];
  canAsk: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ask = useInline(addOpeningQuestionInline);
  // Cleared once the question is taken, not on the click: a refused question
  // stays in the box to be corrected (review of PR #2, 21 Sep).
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (ask.result?.tone === "ok") formRef.current?.reset();
  }, [ask.result]);

  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!canAsk}
        title={canAsk ? undefined : "Only the recruiters on this opening, or a lead, can add a question"}
        className="rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
      >
        {open ? "Close" : "Ask a question"}
      </button>
      {open && (
        <form
          ref={formRef}
          onSubmit={(e) => ask.run(submitted(e).formData)}
          className="mt-3 rounded-xl border border-rule bg-surface px-5 py-4"
        >
          <input type="hidden" name="openingId" value={openingId} />
          <p className="text-[13px] font-semibold">Ask everyone in Follow-up</p>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            Goes with the next follow-up, on WhatsApp and email. Nobody counts as complete until it is answered.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <input
              name="question"
              required
              maxLength={200}
              placeholder="Are you open to working from Kandy?"
              className={`${inputClass} min-w-[260px] flex-1`}
            />
            <SubmitButton
              busy={ask.pending}
              locked={ask.pending}
              pendingLabel="Adding…"
              className="rounded-full bg-brand px-4 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              Add question
            </SubmitButton>
          </div>
          <ActionNote result={ask.result} className="mt-3" />
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
            Already asked: {[...standard, ...custom].join(" · ") || "nothing yet"}
          </p>
        </form>
      )}
    </div>
  );
}
