"use client";

import { useEffect, useState } from "react";
import { approveJd, generateJdInline, saveBriefNotesInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";
import { JdEditor } from "./JdEditor";
import { inputClass } from "./form";
import { BriefRecorder } from "./BriefRecorder";
import { JdChat, type JdChatTurn } from "./JdChat";

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
  chat,
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
  /** The TA's conversation with the AI about this JD (JdChat). */
  chat: JdChatTurn[];
}) {
  const fromLead = otherBriefs.length > 0;
  const [notes, setNotes] = useState(initialNotes);
  const [jdText, setJdText] = useState(jd);
  const generated = jdText.trim().length > 0;

  // What was last saved, so the button can say there is something to save and
  // leaving the page can warn before a recording's transcript is lost.
  const [savedNotes, setSavedNotes] = useState(initialNotes);
  const [sentNotes, setSentNotes] = useState(initialNotes);
  const saveNotes = useInline(saveBriefNotesInline);
  const generate = useInline(generateJdInline);
  // A fresh draft replaces what is in the box once the page has it.
  useEffect(() => setJdText(jd), [jd]);
  useEffect(() => {
    if (saveNotes.result?.ok) setSavedNotes(sentNotes);
    // Only when an answer arrives; sentNotes is what that answer is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveNotes.result]);
  useEffect(() => {
    // Generating saves the notes as typed, so they are no longer unsaved.
    if (generate.result && generate.result.tone !== "error") setSavedNotes(sentNotes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generate.result]);
  const unsaved = notes !== savedNotes;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

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
        <form
          onSubmit={(e) => {
            const { formData } = submitted(e);
            setSentNotes(String(formData.get("notes") ?? ""));
            saveNotes.run(formData);
          }}
          className="px-7 py-6"
        >
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
            <SubmitButton
              busy={saveNotes.pending}
              locked={saveNotes.pending}
              pendingLabel="Saving…"
              tone={unsaved ? "light" : "dark"}
              className={
                unsaved
                  ? "rounded-full bg-brand px-4 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  : "rounded-full border border-rule-strong px-4 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-ink-faint disabled:opacity-60"
              }
            >
              {unsaved ? "Save notes •" : "Save notes"}
            </SubmitButton>
            {unsaved && !saveNotes.pending && <span className="text-[12px] text-warn">Not saved yet</span>}
            {extractedSummary.length > 0 && (
              <span className="text-[12px] text-ink-faint">
                Picked up from the notes:{" "}
                <span className="text-ink-soft">{extractedSummary.join(" · ")}</span>
              </span>
            )}
          </div>
          <ActionNote result={saveNotes.result} className="mt-3" />
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
          <form
            onSubmit={(e) => {
              // Regenerating replaces the JD below, hand edits included.
              if (generated && jdText !== jd && !window.confirm("Regenerate replaces the JD below, including your edits. Continue?")) {
                e.preventDefault();
                return;
              }
              const { formData } = submitted(e);
              setSentNotes(String(formData.get("notes") ?? ""));
              generate.run(formData);
            }}
          >
            <input type="hidden" name="openingId" value={openingId} />
            {/* The notes as typed, saved or not — they are part of the draft. */}
            <input type="hidden" name="notes" value={notes} />
            <SubmitButton
              busy={generate.pending}
              locked={generate.pending}
              pendingLabel="Writing the JD…"
              tone={generated ? "dark" : "light"}
              className={
                generated
                  ? "text-[12.5px] text-ink-soft transition-colors hover:text-ink disabled:opacity-60"
                  : "rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              }
            >
              {generated ? "Regenerate from brief and notes" : "Generate the JD"}
            </SubmitButton>
          </form>
        </div>
        {generate.result && (
          <div className="px-7 pt-4">
            <ActionNote result={generate.result} />
          </div>
        )}

        {generated ? (
          <form action={approveJd} className="px-7 py-6">
            <input type="hidden" name="openingId" value={openingId} />
            <input type="hidden" name="thenGo" value="opening" />
            <JdEditor name="jdMarkdown" value={jdText} onChange={setJdText} />
            <div className="mt-5">
              <JdChat openingId={openingId} turns={chat} currentJd={jdText} approved={false} />
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <SubmitButton
                pendingLabel="Approving…"
                className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                Approve and open the job
              </SubmitButton>
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
