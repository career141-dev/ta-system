"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setWorkingStage } from "@/app/actions";
import type { WorkingStage } from "@/data/types";

const STAGES: WorkingStage[] = ["100%", "Follow-up", "Add-on"];

const STAGE_HINT: Record<WorkingStage, string> = {
  "100%": "Full hunt",
  "Follow-up": "Chasing follow-up",
  "Add-on": "Additional sourcing",
};

const DOT: Record<WorkingStage, string> = {
  "100%": "bg-brand",
  "Follow-up": "bg-warn",
  "Add-on": "bg-sky-500",
};

/**
 * Dropdown button in the persistent context bar allowing the TA to update
 * their working stage for this job: 100%, Follow-up, or Add-on.
 *
 * This stage directly informs the daily End-of-Day (EOD) email effort reporting.
 */
export function WorkingStageMenu({
  openingId,
  stage = "100%",
  size = "small",
}: {
  openingId: string;
  stage?: WorkingStage;
  size?: "normal" | "small";
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<WorkingStage>(stage);
  const [, startTransition] = useTransition();
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrent(stage);
  }, [stage]);

  useEffect(() => {
    const onStageChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ openingId?: string; stage: WorkingStage }>).detail;
      if (detail && (!detail.openingId || detail.openingId === openingId) && STAGES.includes(detail.stage)) {
        setCurrent(detail.stage);
      }
    };
    window.addEventListener("working-stage-changed", onStageChanged);
    return () => window.removeEventListener("working-stage-changed", onStageChanged);
  }, [openingId]);

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
        title={`Current working stage: ${current}`}
        className={`flex items-center gap-1.5 rounded-full border border-rule bg-tag font-medium text-ink-soft transition-colors hover:border-rule-strong hover:text-ink ${pad}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[current] ?? "bg-brand"}`} />
        <span className="text-ink-faint">Stage:</span>
        <span className="font-semibold text-ink">{current}</span>
        <svg width={10} height={10} viewBox="0 0 16 16" aria-hidden="true" className="opacity-60">
          <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1.5 w-[200px] rounded-xl border border-rule bg-surface py-1 shadow-lg"
        >
          <div className="border-b border-rule/60 px-3 py-1.5 text-[10.5px] font-medium text-ink-faint">
            Working Stage
          </div>
          {STAGES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={s === current}
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setCurrent(s);
                setOpen(false);
                window.dispatchEvent(
                  new CustomEvent("working-stage-changed", { detail: { openingId, stage: s } }),
                );
                const fd = new FormData();
                fd.append("openingId", openingId);
                fd.append("stage", s);
                await setWorkingStage(fd);
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors ${
                s === current
                  ? "cursor-default font-semibold text-ink"
                  : "text-ink-soft hover:bg-paper hover:text-ink"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s]}`} />
              <div className="flex flex-col">
                <span>{s}</span>
                <span className="text-[10px] font-normal text-ink-faint">{STAGE_HINT[s]}</span>
              </div>
              {s === current && <span className="ml-auto text-[11px] text-ink-faint">now</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
