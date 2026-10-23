"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Gives the wide Master Sheet its own viewport without moving the report or its
 * forms into the client bundle. CSS full-screen is deliberate: it behaves the
 * same in managed browsers that refuse the native Fullscreen API.
 */
export function MasterSheetViewport({
  children,
  editable,
  personal,
}: {
  children: ReactNode;
  editable: boolean;
  personal: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded]);

  return (
    <div
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? "true" : undefined}
      aria-label={expanded ? "Master Sheet full-screen view" : undefined}
      className={expanded ? "fixed inset-0 z-[100] flex flex-col bg-paper p-3 sm:p-4" : undefined}
    >
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-rule bg-paper px-4 py-3 text-[11.5px] text-ink-soft">
        {editable ? (
          <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm border border-amber-300 bg-amber-50" />Yellow cells can be edited</span>
        ) : personal ? (
          <span className="font-medium text-ink">Your assigned openings and your own work only</span>
        ) : (
          <span className="font-medium text-ink">Read-only Master Sheet</span>
        )}
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm border border-rule bg-surface" />Calculated cells follow live workflow records</span>
        <span>Job status, dates and commercial values are shared across its TA rows.</span>
        <span>Click a calculated value to open its source.</span>
        {editable && (
          <span className="lg:ml-auto" title="The reason is kept in the audit history with who made the change and when.">
            The reason records why a source value changed.
          </span>
        )}
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rule-strong bg-surface px-3 text-[11.5px] font-semibold text-ink shadow-xs transition-[transform,border-color,color] duration-150 ease-out hover:border-brand-line hover:text-brand active:scale-[0.97]"
          title={expanded ? "Exit full-screen table view (Esc)" : "Open the table in a full-screen view"}
        >
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
            </svg>
          )}
          {expanded ? "Exit full screen" : "Full screen"}
        </button>
      </div>

      <div className={expanded ? "min-h-0 flex-1 [&>div]:h-full [&>div]:max-h-none" : undefined}>
        {children}
      </div>
    </div>
  );
}
