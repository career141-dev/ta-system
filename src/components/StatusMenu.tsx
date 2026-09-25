"use client";

import { useEffect, useRef, useState } from "react";
import { setOpeningStatus } from "@/app/actions";
import { SubmitButton } from "./Submit";

export type OpeningStatus = "open" | "on_hold" | "closed" | "filled";

export const STATUS_LABEL: Record<OpeningStatus, string> = {
  open: "Active",
  on_hold: "On hold",
  closed: "Closed",
  filled: "Filled",
};

const TONE: Record<OpeningStatus, string> = {
  open: "border-brand-line bg-brand-soft text-brand",
  on_hold: "border-warn/35 bg-warn-soft text-warn",
  filled: "border-rule bg-tag text-ink-soft",
  closed: "border-rule bg-tag text-ink-faint",
};

const DOT: Record<OpeningStatus, string> = {
  open: "bg-brand",
  on_hold: "bg-warn",
  filled: "bg-ink-faint",
  closed: "bg-rule-strong",
};

const ORDER: OpeningStatus[] = ["open", "on_hold", "filled", "closed"];

/**
 * The status of an opening, where you can actually reach it — findings 05, 06
 * and 07.
 *
 * It used to sit at the foot of the right-hand rail, under the pipeline table,
 * and only for people who were not TAs — so the person running the role could
 * neither see it nor change it. It now rides in the identity band on every
 * screen of the opening, and on each row of the openings list.
 *
 * Whoever works the role can set it. Closing a client's requirement is a normal
 * part of running it, not an administrative privilege.
 */
export function StatusMenu({
  openingId,
  status,
  size = "normal",
}: {
  openingId: string;
  status: OpeningStatus;
  size?: "normal" | "small";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const pad = size === "small" ? "px-2 py-[3px] text-[11px]" : "px-2.5 py-1 text-[12px]";

  return (
    <div ref={box} className="relative">
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-full border font-medium transition-colors ${pad} ${TONE[status]}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
        {STATUS_LABEL[status]}
        <svg width={10} height={10} viewBox="0 0 16 16" aria-hidden="true" className="opacity-60">
          <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <form
          action={setOpeningStatus}
          className="absolute left-0 top-full z-50 mt-1.5 w-[184px] rounded-xl border border-rule bg-surface py-1 shadow-lg"
        >
          <input type="hidden" name="openingId" value={openingId} />
          {ORDER.map((s) => (
            <SubmitButton
              key={s}
              name="status"
              value={s}
              tone="dark"
              disabled={s === status}
              onDone={() => setOpen(false)}
              className={`flex w-full items-center justify-start! gap-2.5 px-3 py-2 text-left text-[12.5px] transition-colors ${
                s === status
                  ? "cursor-default font-semibold text-ink"
                  : "text-ink-soft hover:bg-paper hover:text-ink disabled:opacity-60"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s]}`} />
              {STATUS_LABEL[s]}
              {s === status && <span className="ml-auto text-[11px] text-ink-faint">now</span>}
            </SubmitButton>
          ))}
        </form>
      )}
    </div>
  );
}
