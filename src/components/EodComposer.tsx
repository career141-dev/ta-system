"use client";

import { useEffect, useState } from "react";
import { SHORTLIST_COLUMNS, type EffortRow, type ShortlistRow } from "@/lib/eod-format";
import { EffortSheet } from "./EffortSheet";
import { inputClass } from "./form";
import { sendEod } from "@/app/actions";

/**
 * The end-of-day email, composed for review.
 *
 * Fully editable: the subject line, greeting/intro message, candidate shortlist
 * table cells (age, notice, notes, current company, designation, current/expected remuneration),
 * L-sheet effort numbers/dates/assignee, and sign-off message can all be edited directly on screen.
 * Edits are kept in this browser's localStorage until sent so nothing is lost on page reload.
 */
export function EodComposer({
  openingId,
  kind,
  subject: initialSubject,
  toName,
  toEmail,
  ccName,
  ccEmail,
  trackedAt,
  eodCc,
  fixedCc,
  canAddRecipients,
  rows: initialRows,
  effort,
  senderName,
  alreadyOut,
  openSetNote,
}: {
  openingId: string;
  kind: "director" | "client";
  subject: string;
  toName: string;
  toEmail: string;
  ccName: string;
  ccEmail: string;
  /** The TA's shortlist-replies inbox. Copied in, and on the reply-to. */
  trackedAt: string | null;
  /** Copied on every end-of-day email (People page). */
  eodCc: string | null;
  /** Always copied on the Director's email; the TA cannot take these off. */
  fixedCc: string[];
  /** The Director's email lets the TA add more To and Cc addresses. */
  canAddRecipients: boolean;
  rows: ShortlistRow[];
  effort: EffortRow;
  senderName: string;
  /** A set is already out and unanswered. Sending a second one would leave two
   *  numbered lists in play and no way to tell which a reply answers. */
  alreadyOut: boolean;
  openSetNote: string | null;
}) {
  const draftKey = `eod-composer-draft:${openingId}:${kind}`;
  const defaultIntro = "Dear Sir,\n\nPlease find the attached Shortlisted CV for the above-mentioned position";
  const defaultOutro = `Thank You\nBest Regards,\n\n${senderName}\nExecutive - Talent Acquisition`;

  const [subject, setSubject] = useState(initialSubject);
  const [introText, setIntroText] = useState(defaultIntro);
  const [outroText, setOutroText] = useState(defaultOutro);
  const [shortlistDraft, setShortlistDraft] = useState<Record<string, Partial<ShortlistRow>>>({});
  const [extraTo, setExtraTo] = useState("");
  const [extraCc, setExtraCc] = useState("");

  // Restore draft from localStorage on mount
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        // Only a subject the TA typed, and only while the set and CV count it
        // was typed over still stand: the saved line was the page's own, so a
        // visit before more CVs joined kept "2 CVs" in front of four (28 Sep).
        if (saved.subject !== undefined && saved.subject !== saved.baseSubject && saved.baseSubject === initialSubject) {
          setSubject(saved.subject);
        }
        if (saved.introText !== undefined) setIntroText(saved.introText);
        if (saved.outroText !== undefined) setOutroText(saved.outroText);
        if (saved.shortlistDraft !== undefined) setShortlistDraft(saved.shortlistDraft);
        if (typeof saved.extraTo === "string") setExtraTo(saved.extraTo);
        if (typeof saved.extraCc === "string") setExtraCc(saved.extraCc);
      }
    } catch {
      /* storage disabled */
    }
  }, [draftKey]);

  // Persist draft to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ subject, baseSubject: initialSubject, introText, outroText, shortlistDraft, extraTo, extraCc }),
      );
    } catch {
      /* storage disabled */
    }
  }, [draftKey, subject, initialSubject, introText, outroText, shortlistDraft, extraTo, extraCc]);

  // Clear draft on send
  useEffect(() => {
    const form = document.getElementById("eod-send");
    const clear = () => {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* storage disabled */
      }
    };
    form?.addEventListener("submit", clear);
    return () => form?.removeEventListener("submit", clear);
  }, [draftKey]);

  const updateCandidateField = (appId: string, field: keyof ShortlistRow, value: any) => {
    setShortlistDraft((prev) => ({
      ...prev,
      [appId]: {
        ...prev[appId],
        [field]: value,
      },
    }));
  };

  const getCandidateRow = (r: ShortlistRow): ShortlistRow => {
    const override = shortlistDraft[r.applicationId] || {};
    return {
      ...r,
      ...override,
      notes: override.notes !== undefined ? override.notes : r.notes,
    };
  };

  const effectiveRows = initialRows.map(getCandidateRow);

  const th =
    "whitespace-nowrap border border-rule bg-tag px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-soft";
  const td = "border border-rule px-1.5 py-1 align-top text-[12px]";
  const cellInput =
    "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface transition-colors";

  return (
    <div className="flex flex-col gap-5">
      <section className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <div className="flex flex-col gap-3 border-b border-rule px-7 py-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-[12.5px]">
            <span>
              <span className="text-ink-faint">From </span>
              {senderName} — your own mailbox
            </span>
            <span>
              <span className="text-ink-faint">To </span>
              {toName} <span className="text-ink-faint">{toEmail}</span>
            </span>
            {ccName && (
              <span>
                <span className="text-ink-faint">Cc </span>
                {ccName} <span className="text-ink-faint">{ccEmail}</span>
              </span>
            )}
            {eodCc && (
              <span>
                <span className="text-ink-faint">Cc </span>
                {eodCc}
              </span>
            )}
            {fixedCc.length > 0 && (
              <span>
                <span className="text-ink-faint">Cc </span>
                {fixedCc.join(", ")}
              </span>
            )}
            {trackedAt && (
              <span>
                <span className="text-ink-faint">Cc </span>
                <span className="text-ink-faint">{trackedAt}</span>
              </span>
            )}
          </div>
          {trackedAt && (
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              <span className="text-ink-soft">Reply-to</span> {senderName} and {trackedAt} — so the
              reply reaches you as normal and is tracked, whether they press Reply or Reply All.
              Nothing about what they see changes. One box for the whole desk: the subject line
              above already says which client and which role, so the reply places itself.
            </p>
          )}
          {canAddRecipients && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-3">
                <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-faint">Also To</span>
                <input
                  form="eod-send"
                  name="extraTo"
                  value={extraTo}
                  onChange={(e) => setExtraTo(e.target.value)}
                  placeholder="more addresses, separated by commas"
                  className={`${inputClass} flex-1`}
                />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-faint">Also Cc</span>
                <input
                  form="eod-send"
                  name="extraCc"
                  value={extraCc}
                  onChange={(e) => setExtraCc(e.target.value)}
                  placeholder="more addresses, separated by commas"
                  className={`${inputClass} flex-1`}
                />
              </label>
            </div>
          )}
          <label className="flex items-center gap-3">
            <span className="text-[12.5px] font-medium text-ink-faint">Subject</span>
            <input
              form="eod-send"
              name="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={`${inputClass} flex-1 font-medium`}
            />
          </label>
        </div>

        <div className="px-7 py-6">
          {/* Editable Salutation / Intro */}
          <div className="mb-4">
            <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint mb-1">
              Introductory Greeting & Message
            </label>
            <textarea
              form="eod-send"
              name="introText"
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              rows={Math.max(2, introText.split("\n").length)}
              className="w-full rounded-lg border border-transparent bg-paper/60 p-2.5 text-[13px] leading-[1.8] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface resize-y transition-colors font-sans"
              placeholder="Dear Sir,&#10;&#10;Please find the attached Shortlisted CV..."
            />
          </div>

          {/* Table one — the client snapshot (Fully editable) */}
          <div className="mt-5 overflow-x-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                Candidate Shortlist Table
              </span>
              <span className="text-[11px] text-ink-faint">
                Click any cell to edit details before sending
              </span>
            </div>

            {initialRows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-rule px-5 py-8 text-center text-[12.5px] text-ink-faint">
                {kind === "director"
                  ? "Nobody is ready to go yet — a candidate is ready once their follow-up questions are all answered, or they are in Director Review."
                  : "Nobody is in Client Review yet — move candidates to Client Review to include them in the submission."}
              </p>
            ) : (
              <>
                {(() => {
                  const empty = [
                    ["AGE", effectiveRows.every((r) => !String(r.age ?? "").trim())],
                    ["NOTICE", effectiveRows.every((r) => !String(r.notice ?? "").trim())],
                    ["NOTES", effectiveRows.every((r) => !Array.isArray(r.notes) ? !String(r.notes).trim() : r.notes.every((n) => !n.trim()))],
                    ["CURRENT REMUNERATION", effectiveRows.every((r) => !String(r.currentRemuneration ?? "").trim())],
                    ["EXPECTED REMUNERATION", effectiveRows.every((r) => !String(r.expectedRemuneration ?? "").trim())],
                  ]
                    .filter(([, e]) => e)
                    .map(([h]) => h as string);
                  return empty.length > 0 ? (
                    <p className="mb-3 rounded-lg bg-warn-soft px-3.5 py-2 text-[12px] text-warn">
                      {empty.join(", ")} {empty.length === 1 ? "is" : "are"} empty for everyone in this set. You can type them into the table cells below before sending.
                    </p>
                  ) : null;
                })()}
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      {SHORTLIST_COLUMNS.map((h) => (
                        <th key={h} className={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {effectiveRows.map((r) => {
                      const notesStr = Array.isArray(r.notes) ? r.notes.join("\n") : String(r.notes ?? "");
                      return (
                        <tr key={r.applicationId} className="hover:bg-paper/30 transition-colors">
                          <td className={`${td} tabular font-medium text-ink-faint text-center pt-2.5`}>
                            {r.no}
                          </td>
                          <td className={`${td} min-w-[140px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_name`}
                              value={r.name}
                              onChange={(e) => updateCandidateField(r.applicationId, "name", e.target.value)}
                              className={`${cellInput} font-semibold`}
                            />
                          </td>
                          <td className={`${td} w-[65px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_age`}
                              value={r.age}
                              onChange={(e) => updateCandidateField(r.applicationId, "age", e.target.value)}
                              className={`${cellInput} tabular-nums`}
                            />
                          </td>
                          <td className={`${td} min-w-[95px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_notice`}
                              value={r.notice}
                              onChange={(e) => updateCandidateField(r.applicationId, "notice", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[240px]`}>
                            <textarea
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_notes`}
                              value={notesStr}
                              onChange={(e) =>
                                updateCandidateField(
                                  r.applicationId,
                                  "notes",
                                  e.target.value.split("\n"),
                                )
                              }
                              rows={Math.max(2, notesStr.split("\n").length)}
                              className={`${cellInput} resize-y leading-[1.6] text-ink-soft`}
                            />
                          </td>
                          <td className={`${td} min-w-[140px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_currentCompany`}
                              value={r.currentCompany}
                              onChange={(e) => updateCandidateField(r.applicationId, "currentCompany", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[140px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_currentDesignation`}
                              value={r.currentDesignation}
                              onChange={(e) => updateCandidateField(r.applicationId, "currentDesignation", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[130px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_currentRemuneration`}
                              value={r.currentRemuneration}
                              onChange={(e) => updateCandidateField(r.applicationId, "currentRemuneration", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[130px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_expectedRemuneration`}
                              value={r.expectedRemuneration}
                              onChange={(e) => updateCandidateField(r.applicationId, "expectedRemuneration", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* Table two — the L-sheet, editable before it goes */}
          <div className="mt-8">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                L-Sheet Daily Effort Table
              </span>
              <span className="text-[11px] text-ink-faint">
                Edit outreach counts, targets, stage, date & assignee
              </span>
            </div>
            <EffortSheet
              effort={effort}
              formId="eod-send"
              draftKey={`eod-effort:${openingId}:${effort.date}`}
              openingId={openingId}
            />
          </div>

          {/* Editable Sign-off / Outro */}
          <div className="mt-8">
            <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint mb-1">
              Sign-off & Closing
            </label>
            <textarea
              form="eod-send"
              name="outroText"
              value={outroText}
              onChange={(e) => setOutroText(e.target.value)}
              rows={Math.max(3, outroText.split("\n").length)}
              className="w-full rounded-lg border border-transparent bg-paper/60 p-2.5 text-[13px] leading-[1.8] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface resize-y transition-colors font-sans"
              placeholder="Thank You&#10;Best Regards,&#10;&#10;..."
            />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-rule bg-surface p-7 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <h2 className="text-[13.5px] font-semibold">
          Attachments <span className="ml-1.5 font-normal text-[12px] text-ink-faint">{effectiveRows.length}</span>
        </h2>
        {effectiveRows.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-faint">Nothing to attach.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-1.5">
            {effectiveRows.map((r) => {
              const notesStr = Array.isArray(r.notes) ? r.notes.join("\n") : String(r.notes ?? "");
              return (
                <a
                  key={r.applicationId}
                  href={`/api/prepared-cv/${r.applicationId}?current=${encodeURIComponent(r.currentRemuneration)}&expected=${encodeURIComponent(r.expectedRemuneration)}&notes=${encodeURIComponent(notesStr)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2.5 text-[12.5px] text-brand hover:underline"
                >
                  <span className="text-ink-faint">PDF</span>
                  {r.name} - Career141.pdf
                </a>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          Each one carries the green CAREER141 block on page one with your edited remuneration and notes stamped on top.
        </p>
      </section>

      <form id="eod-send" action={sendEod} className="flex flex-wrap items-center gap-4">
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="to" value={toEmail} />
        {/* The order here is the order they are numbered in the table, which is
            the order the reply's numbers will refer to. */}
        <input
          type="hidden"
          name="applicationIds"
          value={initialRows.map((r) => r.applicationId).join(",")}
        />
        <button
          disabled={initialRows.length === 0}
          className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35 shadow-sm"
        >
          {kind === "director" ? "Send email" : "Record that it went to the client"}
        </button>
      </form>
    </div>
  );
}
