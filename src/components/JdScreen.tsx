"use client";

import { useState } from "react";
import { approveJd, generateJdWithModel, saveBriefNotes } from "@/app/actions";
import { inputClass } from "./form";
import { BriefRecorder } from "./BriefRecorder";
import { SubmitButton } from "@/components/SubmitButton";

/**
 * Screen two, and the TA's whole job in one place: notes in, JD out, approved.
 *
 * What the lead left is shown as it was written; the TA's own notes sit
 * beneath it in a box of their own, so adding to the brief never overwrites
 * it. The JD is drafted from both, together with the opening's details.
 */
export function JdScreen({
  openingId,
  title,
  clientName,
  initialNotes,
  jd,
  extractedSummary,
  otherBriefs,
}: {
  openingId: string;
  title: string;
  clientName: string;
  /** This TA's own notes. */
  initialNotes: string;
  /** Everyone else's: the lead's brief, other TAs' notes. Read-only here. */
  otherBriefs: { id: string; author: string; isLead: boolean; notes: string; at: string }[];
  jd: string;
  extractedSummary: string[];
}) {
  const fromLead = otherBriefs.length > 0;
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
              ? "The JD is written from the brief below and your own notes together."
              : "Whatever you were told about the role. The JD is written from these."}
          </p>
        </div>
        {otherBriefs.map((b) => (
          <div key={b.id} className="border-b border-rule bg-paper/50 px-7 py-5">
            <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-soft">
              {b.isLead ? "Brief" : "Notes"} from {b.author} <span className="font-normal normal-case tracking-normal text-ink-faint">· {b.at}</span>
            </p>
            <p className="whitespace-pre-wrap text-[13px] leading-[1.75] text-ink">{b.notes}</p>
          </div>
        ))}
        <form action={saveBriefNotes} className="px-7 py-6">
          <div className="mb-4">
            <BriefRecorder
              label="Record your notes"
              onTranscript={(text) =>
                setNotes((prev) => `${prev.trim() ? `${prev.trimEnd()}\n\n` : ""}From the recording:\n${text.trim()}`)
              }
            />
          </div>
          {fromLead && <p className="mb-2 text-[12px] font-medium text-ink-soft">Your notes</p>}
          <input type="hidden" name="openingId" value={openingId} />
          <textarea
            name="notes"
            rows={9}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={
              fromLead
                ? "Anything the brief does not say — what you learned from the client since, corrections, must-haves."
                : `Package around LKR 650,000 with fuel and a vehicle allowance. Sri Lankan only. Colombo. Fairly urgent — about 3 weeks.\n\n- CA or CIMA qualified\n- 10+ years, manufacturing background`
            }
            className={`${inputClass} leading-[1.75]`}
          />
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <SubmitButton pendingLabel="Saving…">Save notes</SubmitButton>
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
                : fromLead
                  ? "Written from the brief and your notes together."
                  : "Written from your notes."}
            </p>
          </div>
          <form action={generateJdWithModel}>
            <input type="hidden" name="openingId" value={openingId} />
            {/* The notes as typed, saved or not — they are part of the draft. */}
            <input type="hidden" name="notes" value={notes} />
            <button
              className={
                generated
                  ? "text-[12.5px] text-ink-soft transition-colors hover:text-ink"
                  : "rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
              }
            >
              {generated ? "Regenerate from brief and notes" : "Generate the JD"}
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
              {notes.trim() || fromLead
                ? "Generate it from the notes above."
                : "Add some notes first, or generate an outline to fill in by hand."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
