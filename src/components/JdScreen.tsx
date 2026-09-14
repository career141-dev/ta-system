"use client";

import { useState } from "react";
import { approveJd, generateJdWithModel, saveBriefNotes } from "@/app/actions";
import { inputClass } from "./form";

/**
 * Screen two, and the TA's whole job in one place: notes in, JD out, approved.
 *
 * The notes may already hold what the lead left — the TA adds to them rather
 * than starting blank. Generating rewrites the JD and pulls the package,
 * locations, nationality and urgency onto the opening at the same time, so
 * nothing is typed twice.
 */
export function JdScreen({
  openingId,
  title,
  clientName,
  initialNotes,
  jd,
  extractedSummary,
  fromLead,
}: {
  openingId: string;
  title: string;
  clientName: string;
  initialNotes: string;
  jd: string;
  extractedSummary: string[];
  fromLead: boolean;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [jdText, setJdText] = useState(jd);
  const generated = jdText.trim().length > 0;

  const card =
    "overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]";
  const head = "border-b border-rule px-7 py-4";

  return (
    <div className="flex flex-col gap-5">
      <section className={card}>
        <div className={head}>
          <h2 className="text-[13.5px] font-semibold">Notes</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">
            {fromLead
              ? "What the lead left. Add anything else you were told."
              : "Whatever you were told about the role."}
          </p>
        </div>
        <form action={saveBriefNotes} className="px-7 py-6">
          <input type="hidden" name="openingId" value={openingId} />
          <textarea
            name="notes"
            rows={9}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={`Package around LKR 650,000 with fuel and a vehicle allowance. Sri Lankan only. Colombo. Fairly urgent — about 3 weeks.\n\n- CA or CIMA qualified\n- 10+ years, manufacturing background`}
            className={`${inputClass} leading-[1.75]`}
          />
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <button className="rounded-full border border-rule-strong px-4 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-ink-faint">
              Save notes
            </button>
            {extractedSummary.length > 0 && (
              <span className="text-[12px] text-ink-faint">
                Read from these:{" "}
                <span className="text-ink-soft">{extractedSummary.join(" · ")}</span>
              </span>
            )}
          </div>
        </form>
      </section>

      <section className={card}>
        <div className={`${head} flex flex-wrap items-center justify-between gap-3`}>
          <div>
            <h2 className="text-[13.5px] font-semibold">Job description</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">
              {generated
                ? "Correct anything wrong, then approve."
                : "Written from the notes above."}
            </p>
          </div>
          <form action={generateJdWithModel}>
            <input type="hidden" name="openingId" value={openingId} />
            <button
              className={
                generated
                  ? "text-[12.5px] text-ink-soft transition-colors hover:text-ink"
                  : "rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
              }
            >
              {generated ? "Regenerate from notes" : "Generate the JD"}
            </button>
          </form>
        </div>

        {generated ? (
          <form action={approveJd} className="px-7 py-6">
            <input type="hidden" name="openingId" value={openingId} />
            <input type="hidden" name="thenGo" value="opening" />
            <textarea
              name="jdMarkdown"
              rows={18}
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              className={`${inputClass} leading-[1.8]`}
            />
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90">
                Approve and open the job
              </button>
              <span className="text-[12.5px] text-ink-faint">
                Your edits are saved with the approval. Nothing goes live until then.
              </span>
            </div>
          </form>
        ) : (
          <div className="px-7 py-12 text-center">
            <p className="text-[13px] text-ink-soft">
              Nothing written yet for <span className="text-ink">{title}</span> at {clientName}.
            </p>
            <p className="mt-1.5 text-[12.5px] text-ink-faint">
              {notes.trim()
                ? "Generate it from the notes above."
                : "Add some notes first, or generate an outline to fill in by hand."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
