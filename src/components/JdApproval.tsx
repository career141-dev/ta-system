"use client";

import { useState } from "react";
import { approveJd, generateJdWithModel } from "@/app/actions";

/**
 * The TA's JD step, in the order the desk actually works:
 *
 *   nothing yet  →  generate from the brief  →  read and correct  →  approve
 *
 * Everything the brief yielded — package, locations, nationality, urgency —
 * arrives with the generated JD rather than being typed in again. The gate at
 * the end is what stops a wrong JD reaching a client.
 */
export function JdApproval({
  openingId,
  jd,
  canApprove,
  approverLabel,
  briefSummary,
  hasBrief,
}: {
  openingId: string;
  jd: string;
  canApprove: boolean;
  approverLabel: string;
  briefSummary: string[];
  hasBrief: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(jd);
  const generated = jd.trim().length > 0;

  if (!generated) {
    return (
      <section className="mb-7 overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <div className="flex flex-wrap items-center gap-5 px-7 py-6">
          <div className="min-w-[280px] flex-1">
            <h2 className="text-[15px] font-semibold">The JD has not been written yet</h2>
            <p className="mt-1.5 max-w-[64ch] text-[13px] leading-relaxed text-ink-soft">
              {hasBrief
                ? "Generate it from the brief the lead left. The package, locations, nationality and urgency come through with it — you only correct what is wrong."
                : "No brief was left, so there is nothing to generate from. Write it directly once you have spoken to the lead."}
            </p>
            {briefSummary.length > 0 && (
              <p className="mt-3 text-[12.5px] text-ink-faint">
                From the brief: <span className="text-ink-soft">{briefSummary.join(" · ")}</span>
              </p>
            )}
          </div>
          {canApprove && (
            <a
              href={`/openings/${openingId}/jd`}
              className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Write the JD
            </a>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="mb-7 overflow-hidden rounded-2xl border border-warn/40 bg-warn-soft/50">
      <div className="flex flex-wrap items-center gap-4 px-7 py-5">
        <div className="min-w-[260px] flex-1">
          <p className="text-[14px] font-semibold text-warn">Waiting for approval</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">
            {canApprove
              ? "Read it through and correct anything wrong. Nothing goes live until you approve."
              : `${approverLabel} has to read and approve it.`}
          </p>
        </div>
        <a
          href={`/openings/${openingId}/jd`}
          className="rounded-full border border-warn/50 bg-surface/60 px-4 py-2 text-[12.5px] font-medium text-warn transition-colors hover:bg-surface"
        >
          {canApprove ? "Review and approve" : "Read the JD"}
        </a>
      </div>

      {open && (
        <form action={approveJd} className="border-t border-warn/30 bg-surface px-7 py-6">
          <input type="hidden" name="openingId" value={openingId} />
          <textarea
            name="jdMarkdown"
            rows={18}
            value={text}
            onChange={(ev) => setText(ev.target.value)}
            readOnly={!canApprove}
            className="w-full rounded-xl border border-rule bg-surface px-5 py-4 text-[13px] leading-[1.8] outline-none transition-colors focus:border-brand focus:ring-[3px] focus:ring-brand/12"
          />
          {canApprove ? (
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90">
                Approve
              </button>
              <form action={generateJdWithModel}>
                <input type="hidden" name="openingId" value={openingId} />
                <button className="text-[12.5px] text-ink-soft transition-colors hover:text-ink">
                  Regenerate from the brief
                </button>
              </form>
              <span className="text-[12.5px] text-ink-faint">
                Your edits are saved with the approval.
              </span>
            </div>
          ) : (
            <p className="mt-5 text-[12.5px] text-ink-soft">
              Read-only — only an assigned TA can approve.
            </p>
          )}
        </form>
      )}
    </section>
  );
}
