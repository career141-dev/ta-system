"use client";

import { useState } from "react";
import {
  EFFORT_COLUMNS,
  SHORTLIST_COLUMNS,
  UNDEFINED_COLUMNS,
  type EffortRow,
  type ShortlistRow,
} from "@/lib/eod-format";
import { inputClass } from "./form";
import { sendEod } from "@/app/actions";

/**
 * The end-of-day email, composed for review.
 *
 * Table one is the client snapshot the desk builds by hand in Sheets every
 * evening; table two is the L-sheet. Both are drawn with the column names from
 * the real emails, so what arrives in the Director's inbox looks like what he
 * already reads.
 *
 * Never sent on its own — spec §10.3. The Director's copy is sent through
 * Microsoft Graph when the TA presses Send, from their own mailbox, copying the
 * TA Lead, the desk's end-of-day copy and the shortlist inbox.
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
  rows,
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
  rows: ShortlistRow[];
  effort: EffortRow;
  senderName: string;
  /** A set is already out and unanswered. Sending a second one would leave two
   *  numbered lists in play and no way to tell which a reply answers. */
  alreadyOut: boolean;
  openSetNote: string | null;
}) {
  const [subject, setSubject] = useState(initialSubject);

  const th =
    "whitespace-nowrap border border-rule bg-tag px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-soft";
  const td = "border border-rule px-2.5 py-2 align-top text-[12px]";

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
          <label className="flex items-center gap-3">
            <span className="text-[12.5px] text-ink-faint">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={`${inputClass} flex-1`}
            />
          </label>
        </div>

        <div className="px-7 py-6">
          <p className="text-[13px] leading-[1.8]">
            Dear Sir,
            <br />
            <br />
            Please find the attached Shortlisted CV for the above-mentioned position
          </p>

          {/* Table one — the client snapshot */}
          <div className="mt-5 overflow-x-auto">
            {rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-rule px-5 py-8 text-center text-[12.5px] text-ink-faint">
                Nobody is ready to go yet — a candidate is ready once their follow-up questions are all answered, or they are in Director Review. There is nothing to
                send.
              </p>
            ) : (
              <>
              {(() => {
                // The email's columns never change (the Director reads this
                // format), so an empty column is pointed out instead of hidden.
                const empty = [
                  ["AGE", rows.every((r) => !r.age.trim())],
                  ["NOTICE", rows.every((r) => !r.notice.trim())],
                  ["NOTES", rows.every((r) => r.notes.every((n) => !n.trim()))],
                  ["CURRENT REMUNERATION", rows.every((r) => !r.currentRemuneration.trim())],
                  ["EXPECTED REMUNERATION", rows.every((r) => !r.expectedRemuneration.trim())],
                ].filter(([, e]) => e).map(([h]) => h as string);
                return empty.length > 0 ? (
                  <p className="mb-3 rounded-lg bg-warn-soft px-3.5 py-2 text-[12px] text-warn">
                    {empty.join(", ")} {empty.length === 1 ? "is" : "are"} empty for everyone in this set. Fill them in on each
                    candidate before sending, or the Director gets blank columns.
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
                  {rows.map((r) => (
                    <tr key={r.applicationId}>
                      <td className={`${td} tabular`}>{r.no}</td>
                      <td className={`${td} whitespace-nowrap font-medium`}>{r.name}</td>
                      <td className={td}>{r.location}</td>
                      <td className={`${td} tabular`}>{r.age}</td>
                      <td className={`${td} whitespace-nowrap`}>{r.notice}</td>
                      <td className={`${td} min-w-[220px] leading-[1.6] text-ink-soft`}>
                        {r.notes.map((n) => (
                          <span key={n} className="block">
                            {n}
                          </span>
                        ))}
                      </td>
                      <td className={td}>{r.currentCompany}</td>
                      <td className={td}>{r.currentDesignation}</td>
                      <td className={td}>{r.currentRemuneration}</td>
                      <td className={td}>{r.expectedRemuneration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </>
            )}
          </div>

          {/* Table two — the L-sheet */}
          <div className="mt-7 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {EFFORT_COLUMNS.map((c) => (
                    <th key={c.key} className={th}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {EFFORT_COLUMNS.map((c) => {
                    const v = effort[c.key as keyof EffortRow];
                    const undef = UNDEFINED_COLUMNS.has(c.key);
                    return (
                      <td
                        key={c.key}
                        className={`${td} tabular ${undef ? "bg-paper/60" : ""}`}
                        title={undef ? "Not defined yet — left blank rather than reported as zero" : undefined}
                      >
                        {undef || v === null ? "" : String(v)}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11.5px] text-ink-faint">
              POST, ADD-ONS and BACK-UP are blank because they are not defined yet — a blank says
              &ldquo;not tracked&rdquo;, a zero would say &ldquo;nothing happened&rdquo;.
            </p>
          </div>

          <p className="mt-7 text-[13px] leading-[1.8]">
            Thank You
            <br />
            Best Regards,
            <br />
            <br />
            {senderName}
            <br />
            <span className="text-ink-soft">Executive - Talent Acquisition</span>
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-rule bg-surface p-7 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <h2 className="text-[13.5px] font-semibold">
          Attachments <span className="ml-1.5 font-normal text-[12px] text-ink-faint">{rows.length}</span>
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-faint">Nothing to attach.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-1.5">
            {rows.map((r) => (
              <a
                key={r.applicationId}
                href={`/api/prepared-cv/${r.applicationId}?current=${encodeURIComponent(r.currentRemuneration)}&expected=${encodeURIComponent(r.expectedRemuneration)}&notes=${encodeURIComponent(r.notes.join("\n"))}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2.5 text-[12.5px] text-brand hover:underline"
              >
                <span className="text-ink-faint">PDF</span>
                {r.name} - Career141.pdf
              </a>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          Each one carries the green CAREER141 block on page one, so the Director reads the package and
          the notes without going back to the email.
        </p>
      </section>

      <form action={sendEod} className="flex flex-wrap items-center gap-4">
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="subject" value={subject} />
        <input type="hidden" name="to" value={toEmail} />
        {/* The order here is the order they are numbered in the table, which is
            the order the reply's numbers will refer to. */}
        <input
          type="hidden"
          name="applicationIds"
          value={rows.map((r) => r.applicationId).join(",")}
        />
        <button
          disabled={rows.length === 0}
          className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35"
        >
          {kind === "director" ? "Send email" : "Record that it went to the client"}
        </button>
        <span className="max-w-[62ch] text-[12.5px] text-ink-faint">
          {rows.length === 0
            ? "Nobody new to send — everyone at this stage has already gone out."
            : kind === "director"
              ? `Sends this email now from your mailbox through Microsoft Graph, with the ${rows.length} CV${rows.length === 1 ? "" : "s"} attached, and holds the list for the Director's reply. ${openSetNote ?? ""}`
              : `The client email is sent by operations, not from here. Record it once it has gone, so the reply to the shortlist inbox can be read back onto these ${rows.length}.`}
          {alreadyOut && " An earlier set is still waiting on a reply — that is fine; replies are matched by the date in their subject."}
        </span>
      </form>
    </div>
  );
}
