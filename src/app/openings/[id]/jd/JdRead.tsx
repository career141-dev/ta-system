"use client";

import { useState } from "react";
import { amendJd } from "@/app/actions";

/**
 * The approved JD — finding 01.
 *
 * Until the 12 Sep sweep this document disappeared the moment it was approved:
 * the page redirected away and the overview stopped rendering it. It is the
 * text the snippet is written from and the vocabulary the sourcing searches
 * are built on, so it has to stay readable, quotable and correctable.
 */
export function JdRead({
  openingId,
  jd,
  approvedBy,
  approvedAt,
  canAmend,
}: {
  openingId: string;
  jd: string;
  approvedBy: string | null;
  approvedAt: string | null;
  canAmend: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <section className="overflow-hidden rounded-2xl border border-rule bg-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-rule bg-paper/60 px-6 py-3.5">
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-brand">
          <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5.2 8.2l2 2 3.6-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Approved
        </span>
        {approvedBy && (
          <span className="text-[12px] text-ink-soft">
            by {approvedBy}
            {approvedAt && ` · ${approvedAt}`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(jd);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
            className="rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {canAmend && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="rounded-full border border-brand-line px-3.5 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft"
            >
              Amend
            </button>
          )}
        </div>
      </header>

      {editing ? (
        <form action={amendJd} className="px-6 py-5">
          <input type="hidden" name="openingId" value={openingId} />
          <textarea
            name="jdMarkdown"
            defaultValue={jd}
            rows={24}
            autoFocus
            className="w-full resize-y rounded-xl border border-rule bg-surface px-4 py-3 font-mono text-[12.5px] leading-relaxed outline-none focus:border-brand"
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90">
              Save the amendment
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-2 text-[13px] text-ink-soft transition-colors hover:text-ink"
            >
              Cancel
            </button>
            <span className="text-[11.5px] leading-relaxed text-ink-faint">
              It stays approved — a correction does not send the opening back for sign-off.
            </span>
          </div>
        </form>
      ) : (
        <div className="whitespace-pre-wrap px-6 py-5 text-[13.5px] leading-[1.75]">{jd}</div>
      )}
    </section>
  );
}
