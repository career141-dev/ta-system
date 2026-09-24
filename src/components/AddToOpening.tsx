"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { addToOpeningInline } from "@/app/actions";
import type { ActionResult } from "@/lib/inlineResult";
import { ActionNote, SubmitButton, submitted, useInline } from "@/components/Submit";

/**
 * "Add to an opening", with its answer where it was asked.
 *
 * Three screens had their own copy of this form, and each sent the answer to
 * the top of the page — behind the database drawer, where nobody saw it
 * (testing, 21 Sep). One form now, and the answer lands under its button:
 * green when they are in Follow-up, amber when they were added but not moved
 * (with the reason), red when they were not added at all.
 *
 *   card    — a titled card with a picker (candidate page, database drawer)
 *   compact — a picker in a row, with Cancel (database results)
 *   single  — one button for one opening (the "may fit" list)
 */
export function AddToOpening({
  candidateId,
  openings,
  variant,
  defaultOpeningId,
  onCancel,
}: {
  candidateId: string;
  openings: { id: string; label: string }[];
  variant: "card" | "compact" | "single";
  defaultOpeningId?: string | null;
  onCancel?: () => void;
}) {
  const add = useInline(addToOpeningInline);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // The answer showing when this press was made. It belongs to the previous
  // press: counting it made a second opening read as added the moment it was
  // picked, before the server had answered (review of PR #2, 21 Sep).
  const [before, setBefore] = useState<ActionResult | null>(null);
  // Once added, an opening is not offered again, even before the page reloads.
  const [added, setAdded] = useState<string[]>([]);
  const offered = openings.filter((o) => !added.includes(o.id));

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const { formData } = submitted(e);
    const openingId = String(formData.get("openingId") ?? "");
    setSentTo(openingId);
    setBefore(add.result);
    add.run(formData);
  };

  // Record the opening once the answer says they are on it.
  const landed = !add.pending && add.result && add.result !== before && add.result.tone !== "error" && sentTo;
  useEffect(() => {
    if (landed && sentTo) setAdded((prev) => (prev.includes(sentTo) ? prev : [...prev, sentTo]));
  }, [landed, sentTo]);

  const next = landed ? (
    <Link
      href={add.result!.tone === "ok" ? `/openings/${sentTo}/pipeline/ta_follow_up` : `/openings/${sentTo}/database`}
      className="text-[12px] font-medium text-accent hover:underline"
    >
      {add.result!.tone === "ok" ? "Open TA Follow-up →" : "Open Database CVs →"}
    </Link>
  ) : null;

  const button = (label: string, className: string) => (
    <SubmitButton busy={add.pending} locked={add.pending} pendingLabel="Adding…" className={className}>
      {label}
    </SubmitButton>
  );

  if (variant === "single") {
    const [only] = openings;
    return (
      <form onSubmit={onSubmit} className="flex flex-col items-end gap-1.5">
        <input type="hidden" name="candidateId" value={candidateId} />
        <input type="hidden" name="openingId" value={only?.id ?? ""} />
        {landed ? (
          <span className="text-[12px] font-medium text-brand">{add.result!.tone === "ok" ? "✓ Added" : "Added"}</span>
        ) : (
          button("Add", "rounded-full border border-rule px-3 py-1 text-[12px] font-medium hover:bg-paper disabled:opacity-60")
        )}
        {add.result && add.result.tone !== "ok" && <ActionNote result={add.result} className="max-w-[260px]" />}
      </form>
    );
  }

  const picker = (className: string) => (
    <select
      key={offered.map((o) => o.id).join()}
      name="openingId"
      required
      defaultValue={defaultOpeningId && offered.some((o) => o.id === defaultOpeningId) ? defaultOpeningId : offered[0]?.id}
      className={className}
    >
      {offered.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );

  if (variant === "compact") {
    return (
      <form onSubmit={onSubmit} className="flex w-full flex-col gap-2">
        <input type="hidden" name="candidateId" value={candidateId} />
        {offered.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              {picker(
                "appearance-none rounded-full border border-rule bg-surface py-1.5 pl-3.5 pr-8 text-[12px] outline-none focus:border-brand",
              )}
              <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
                <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            {button("Add", "rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60")}
            {onCancel && (
              <button type="button" onClick={onCancel} className="px-1.5 text-[12px] text-ink-soft hover:text-ink">
                {add.result?.ok ? "Close" : "Cancel"}
              </button>
            )}
          </div>
        )}
        <ActionNote result={add.result} />
        {next}
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-rule bg-surface px-5 py-4">
      <input type="hidden" name="candidateId" value={candidateId} />
      <h3 className="text-[13px] font-semibold">Add to an opening</h3>
      <p className="mt-1 text-[12px] text-ink-faint">Goes straight into TA Follow-up, claimed by you.</p>
      {offered.length > 0 ? (
        <>
          {picker(
            "mt-2.5 w-full rounded border border-rule bg-paper px-2.5 py-2 text-[12.5px] outline-none transition-colors focus:border-brand",
          )}
          {button(
            "Add",
            "mt-2.5 rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50",
          )}
        </>
      ) : (
        <p className="mt-2.5 text-[12px] text-ink-soft">They are on every opening you can add them to.</p>
      )}
      <ActionNote result={add.result} className="mt-3" />
      {next && <div className="mt-2">{next}</div>}
    </form>
  );
}
