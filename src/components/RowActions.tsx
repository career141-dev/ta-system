"use client";

import { useState } from "react";
import { PIPELINE_STAGES, CLOSED_STAGES, STAGE_LABEL, type Candidate, type Stage } from "@/data/types";
import { declineOffer, moveBackToTablesInline, moveStageInline, scheduleInterviewInline, toggleAddOnInline, toggleBackupInline } from "@/app/actions";
import { ActionNote, SubmitButton, Spinner, latest, submitted, useInline } from "./Submit";
import { directorReviewBlockers, nextStages } from "@/lib/pipeline";
import { inputClass } from "./form";

const REASONS = [
  "Not enough sector experience",
  "Package expectation above range",
  "Notice period too long",
  "Client passed",
  "Withdrew — counter-offered",
  "Accepted another offer",
  "Other",
];

/**
 * Change stage and Reject, both working. Reject asks for a reason, because a
 * rejection with no reason is exactly the thing the desk cannot answer for
 * later when the client asks why someone was dropped.
 */
const DECLINE_REASONS = [
  "Accepted another offer",
  "Counter-offered by current employer",
  "Package not agreed",
  "Family or relocation",
  "Went quiet",
];

export function RowActions({
  appId,
  openingId,
  current,
  candidate,
  app,
  isAddOn = false,
  isBackup = false,
  canDecideDirector = false,
  canDecideClient = false,
  backToTables = false,
}: {
  appId: string;
  openingId: string;
  current: Stage;
  /** For the Director Review preview below — what the backend's own gate checks. */
  candidate?: Pick<Candidate, "cvFileName" | "currentSalary" | "expectedSalary" | "noticePeriodDays">;
  app?: { cvFileName?: string | null; cvFileId?: string | null } | null;
  isAddOn?: boolean;
  /** Tagged as cover for someone at interview or offer (convex/lib/backup). */
  isBackup?: boolean;
  /** Whether this person may record a director decision by hand. The server
   *  checks again; this only decides what the menu offers. */
  canDecideDirector?: boolean;
  canDecideClient?: boolean;
  /** They were put on the pipeline from an Excel Tables row, so the menu can
   *  offer to send them back there. */
  backToTables?: boolean;
}) {
  const missingForDirector = candidate ? directorReviewBlockers(candidate, app) : [];
  const [open, setOpen] = useState<false | "stage" | "reject" | "dropout" | "decline" | "interview">(false);
  const allowed = nextStages(current);
  // Each button answers here, under the buttons — the sheet sits over the
  // page, so an answer at the top of the page was out of sight (21 Sep).
  const addOn = useInline(toggleAddOnInline);
  const backup = useInline(toggleBackupInline);
  const move = useInline(moveStageInline);
  const book = useInline(scheduleInterviewInline);
  const back = useInline(moveBackToTablesInline);
  const [movingTo, setMovingTo] = useState<Stage | null>(null);
  const busy = addOn.pending || backup.pending || move.pending || book.pending || back.pending;
  const answer = latest(addOn.result, backup.result, move.result, book.result, back.result);
  const moveTo = (e: React.FormEvent<HTMLFormElement>) => {
    const { formData } = submitted(e);
    setMovingTo(String(formData.get("stage")) as Stage);
    setOpen(false);
    move.run(formData);
  };

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
    <div className="relative flex flex-wrap items-center gap-2 sm:justify-end">
      <form onSubmit={(e) => addOn.run(submitted(e).formData)}>
        <input type="hidden" name="appId" value={appId} />
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="on" value={isAddOn ? "0" : "1"} />
        <SubmitButton
          busy={addOn.pending}
          locked={busy}
          pendingLabel="Saving…"
          tone="dark"
          className={`whitespace-nowrap rounded-full border px-3.5 py-[7px] text-[12.5px] transition-colors disabled:opacity-60 ${
            isAddOn
              ? "border-brand bg-brand-soft font-medium text-brand"
              : "border-rule-strong text-ink-soft hover:border-ink-faint hover:text-ink"
          }`}
        >
          {isAddOn ? "Add-on ✓" : "Add-on"}
        </SubmitButton>
      </form>
      <form onSubmit={(e) => backup.run(submitted(e).formData)}>
        <input type="hidden" name="appId" value={appId} />
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="on" value={isBackup ? "0" : "1"} />
        <SubmitButton
          busy={backup.pending}
          locked={busy}
          pendingLabel="Saving…"
          tone="dark"
          className={`whitespace-nowrap rounded-full border px-3.5 py-[7px] text-[12.5px] transition-colors disabled:opacity-60 ${
            isBackup
              ? "border-brand bg-brand-soft font-medium text-brand"
              : "border-rule-strong text-ink-soft hover:border-ink-faint hover:text-ink"
          }`}
        >
          {isBackup ? "Backup ✓" : "Backup"}
        </SubmitButton>
      </form>
      <button
        onClick={() => setOpen(open === "stage" ? false : "stage")}
        disabled={busy}
        aria-busy={move.pending}
        className="inline-flex items-center gap-2 rounded-full border border-brand-line px-3.5 py-[7px] text-[12.5px] font-medium text-brand hover:bg-brand-soft whitespace-nowrap disabled:opacity-60"
      >
        {(move.pending || back.pending) && <Spinner tone="dark" />}
        {back.pending
          ? "Moving back…"
          : move.pending && movingTo
            ? `Moving to ${STAGE_LABEL[movingTo]}…`
            : "Change stage"}
      </button>
      {current === "offer" ? (
        <button
          onClick={() => setOpen(open === "decline" ? false : "decline")}
          className="rounded-full border border-rule-strong px-3.5 py-[7px] text-[12.5px] text-ink-soft hover:border-ink-faint hover:text-ink"
        >
          Declined
        </button>
      ) : (
        <button
          onClick={() => setOpen(open === "reject" ? false : "reject")}
          className="rounded-full border border-rule-strong px-3.5 py-[7px] text-[12.5px] text-ink-soft hover:border-ink-faint hover:text-ink"
        >
          Reject
        </button>
      )}

      {open === "stage" && (
        <div className="absolute left-0 top-full z-30 mt-2 w-[210px] max-w-[calc(100vw-32px)] sm:left-auto sm:right-0 rounded-xl border border-rule bg-surface py-1.5 text-left shadow-lg">
          <p className="px-3.5 py-1.5 text-[11px] uppercase tracking-wider text-ink-faint">
            Move to
          </p>
          {/* Only the moves the state machine allows. Offering one that will be
              refused is worse than not offering it — the TA presses it, nothing
              happens, and they stop trusting the menu. */}
          {PIPELINE_STAGES.filter((s) => s !== current && allowed.includes(s)).map((s) => {
            // Some moves are not moves. Each says where the real route is
            // instead of offering a button the server will refuse.
            const elsewhere =
              s === "offer"
                ? "use Make offer"
                : s === "placed"
                  ? "use Record placement"
                  : s === "director_shortlist" && !canDecideDirector
                    ? "from the Director's reply"
                    : s === "client_shortlist" && !canDecideClient
                      ? "from the client's reply"
                      : null;
            if (s === "interview") {
              // Interview is not a move, it is a booking. Without a date there
              // is nothing to confirm and nothing to chase.
              return (
                <button
                  key={s}
                  onClick={() => setOpen("interview")}
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] hover:bg-paper"
                >
                  {STAGE_LABEL[s]}
                  <span className="ml-auto text-[11px] text-ink-faint">needs a date</span>
                </button>
              );
            }
            if (elsewhere) {
              return (
                <div
                  key={s}
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] text-ink-faint"
                  title={`Not moved from here — ${elsewhere}.`}
                >
                  {STAGE_LABEL[s]}
                  <span className="ml-auto text-[11px]">{elsewhere}</span>
                </div>
              );
            }
            // Director Review has its own gate: a CV, current salary, expected
            // salary and notice period. Rather than a button that presses and
            // does nothing (the exact confusion that sent someone hunting for a
            // candidate who never made it), it says what is still outstanding.
            // Still a real button — the fields may be there and this proxy just
            // cannot see them — so it can still be pressed once it looks right.
            if (s === "director_review" && missingForDirector.length > 0) {
              return (
                <form key={s} onSubmit={moveTo}>
                  <input type="hidden" name="appId" value={appId} />
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="stage" value={s} />
                  <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] hover:bg-paper">
                    {STAGE_LABEL[s]}
                    <span className="ml-auto text-[11px] text-warn">needs {missingForDirector.join(", ")}</span>
                  </button>
                </form>
              );
            }
            return (
              <form key={s} onSubmit={moveTo}>
                <input type="hidden" name="appId" value={appId} />
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="stage" value={s} />
                <button className="w-full px-3.5 py-2 text-left text-[13px] hover:bg-paper">
                  {STAGE_LABEL[s]}
                </button>
              </form>
            );
          })}
          <div className="my-1 border-t border-rule" />
          {/* Both closed stages ask why. A rejection or a drop-out with no
              reason is the row nobody can explain to the client later. */}
          {CLOSED_STAGES.filter((s) => s !== current && allowed.includes(s)).map((s) => (
            <button
              key={s}
              onClick={() => setOpen(s === "rejected" ? "reject" : "dropout")}
              className="w-full px-3.5 py-2 text-left text-[13px] text-ink-soft hover:bg-paper"
            >
              {STAGE_LABEL[s]}…
            </button>
          ))}
          {backToTables && (
            <form
              onSubmit={(e) => {
                const { formData } = submitted(e);
                setOpen(false);
                back.run(formData);
              }}
            >
              <input type="hidden" name="appId" value={appId} />
              <input type="hidden" name="openingId" value={openingId} />
              <button
                className="w-full px-3.5 py-2 text-left text-[13px] text-ink-soft hover:bg-paper"
                title="Off the pipeline and back on their Excel Tables row, where Add to pipeline puts them back."
              >
                Back to Excel Tables
              </button>
            </form>
          )}
        </div>
      )}

      {open === "interview" && (
        <form
          onSubmit={(e) => {
            const { formData } = submitted(e);
            setOpen(false);
            book.run(formData);
          }}
          className="absolute left-0 top-full z-30 mt-2 w-[330px] max-w-[calc(100vw-32px)] sm:left-auto sm:right-0 rounded-xl border border-rule bg-surface p-4 text-left shadow-lg"
        >
          <input type="hidden" name="appId" value={appId} />
          <input type="hidden" name="openingId" value={openingId} />
          <p className="text-[12.5px] font-medium">Book the interview</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
            The confirmation chase, the reminder and the morning-after follow-up all run off this
            time, so the stage cannot be entered without it.
          </p>

          <label className="mt-3 block">
            <span className="mb-1 block text-[11.5px] text-ink-soft">Interview name</span>
            <input name="title" placeholder="Technical interview" className={inputClass} />
          </label>

          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label>
              <span className="mb-1 block text-[11.5px] text-ink-soft">Date</span>
              <input name="date" type="date" required className={inputClass} />
            </label>
            <label>
              <span className="mb-1 block text-[11.5px] text-ink-soft">Time</span>
              <input name="time" type="time" required className={inputClass} />
            </label>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label>
              <span className="mb-1 block text-[11.5px] text-ink-soft">How</span>
              <select name="mode" defaultValue="in_person" className={`${inputClass} cursor-pointer`}>
                <option value="in_person">In person</option>
                <option value="video">Video</option>
                <option value="phone">Phone</option>
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[11.5px] text-ink-soft">Minutes</span>
              <input name="durationMins" type="number" min={15} step={15} defaultValue={45} className={inputClass} />
            </label>
          </div>

          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-ink-soft">Where, or the link</span>
            <input name="location" placeholder="Client office, Colombo 03" className={inputClass} />
          </label>

          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-ink-soft">Who is taking it</span>
            <input name="interviewers" placeholder="Ayesha Perera, Head of HR" className={inputClass} />
          </label>

          {/* The action always read a notes field that no form rendered, so
              interview notes could never be entered at all. */}
          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-ink-soft">Anything to note</span>
            <input
              name="notes"
              placeholder="Ask for the portfolio beforehand"
              className={inputClass}
            />
          </label>

          <div className="mt-3.5 flex items-center gap-2.5">
            <button className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white">
              Book and move
            </button>
            <button type="button" onClick={() => setOpen(false)} className="px-2 text-[12.5px] text-ink-soft hover:text-ink">
              Cancel
            </button>
          </div>
        </form>
      )}

      {open === "decline" && (
        <form
          action={declineOffer}
          className="absolute left-0 top-full z-30 mt-2 w-[280px] max-w-[calc(100vw-32px)] sm:left-auto sm:right-0 rounded-xl border border-rule bg-surface p-4 text-left shadow-lg"
        >
          <input type="hidden" name="appId" value={appId} />
          <input type="hidden" name="openingId" value={openingId} />
          <p className="text-[12.5px] font-medium">The offer was turned down</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
            Cover is suggested straight away from people already in the pool.
          </p>
          <div className="relative mt-3">
            <select
              name="reason"
              defaultValue={DECLINE_REASONS[0]}
              className="w-full cursor-pointer appearance-none rounded-lg border border-rule bg-surface py-2 pl-2.5 pr-9 text-[13px] outline-none transition-colors focus:border-brand"
            >
              {DECLINE_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div className="mt-3.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2.5 py-1.5 text-[12.5px] text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
            <SubmitButton
              pendingLabel="Finding cover…"
              className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60"
            >
              Find cover
            </SubmitButton>
          </div>
        </form>
      )}

      {(open === "reject" || open === "dropout") && (
        <form
          onSubmit={moveTo}
          className="absolute left-0 top-full z-30 mt-2 w-[260px] max-w-[calc(100vw-32px)] sm:left-auto sm:right-0 rounded-xl border border-rule bg-surface p-3.5 text-left shadow-lg"
        >
          <input type="hidden" name="appId" value={appId} />
          <input type="hidden" name="openingId" value={openingId} />
          <input type="hidden" name="stage" value={open === "reject" ? "rejected" : "dropped_out"} />
          <label className="block text-[11px] uppercase tracking-wider text-ink-faint">
            Reason
          </label>
          <div className="relative mt-1.5">
            <select
              name="reason"
              defaultValue={REASONS[0]}
              className="w-full cursor-pointer appearance-none rounded-lg border border-rule bg-surface py-2 pl-2.5 pr-9 text-[13px] outline-none transition-colors focus:border-brand"
            >
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <input
            name="reasonOther"
            placeholder="If other — say what, in a few words"
            className="mt-2 w-full rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2.5 py-1.5 text-[12.5px] text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
            <button className="rounded-full bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white">
              {open === "reject" ? "Reject" : "Mark dropped out"}
            </button>
          </div>
        </form>
      )}
    </div>
    <ActionNote result={answer} className="max-w-[440px]" />
    </div>
  );
}
