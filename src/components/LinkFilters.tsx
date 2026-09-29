"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/**
 * The filter side of Excel Tables' sheet bar (the desk, 29 Sep): which people
 * to show — all, pending, interested, not interested — and add-ons only. The
 * sheets (All, L1, L2…) are the tabs on the other side; these narrow the
 * sheet that is open. Each choice is a link the server worked out, so the
 * address stays the source of truth.
 *
 * A menu of our own rather than the browser's select, drawn like the rest of
 * the desk: the dot is the colour of the row's status badge (29 Sep review).
 */
const DOT: Record<string, string> = {
  "": "bg-ink-faint",
  pending: "bg-warn",
  interested: "bg-brand",
  not_interested: "bg-danger",
};

export function LinkFilters({
  status,
  options,
  addons,
}: {
  status: string;
  options: { key: string; label: string; count: number; href: string }[];
  addons: { on: boolean; count: number; href: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const go = (href: string) => {
    setOpen(false);
    start(() => router.push(href));
  };
  const current = options.find((o) => o.key === status) ?? options[0];

  // Closed by a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const chip = (on: boolean) =>
    `inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
      on ? "border-brand bg-brand-soft font-medium text-brand" : "border-rule bg-surface text-ink-soft hover:border-ink-faint hover:text-ink"
    }`;

  return (
    <div className={`flex items-center gap-2 transition-opacity ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <div ref={box} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={chip(!!status)}
        >
          <span className={`h-2 w-2 rounded-full ${DOT[current.key]}`} aria-hidden />
          <span>
            <span className={status ? "" : "text-ink-faint"}>Showing:</span> {current.label}
          </span>
          <span className="tabular-nums text-ink-faint">{current.count}</span>
          <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <ul
            role="menu"
            aria-label="Show"
            className="absolute right-0 top-[calc(100%+6px)] z-30 w-56 overflow-hidden rounded-xl border border-rule bg-surface py-1.5 shadow-[0_8px_24px_rgba(23,28,24,0.12)]"
          >
            {options.map((o) => {
              const on = o.key === status;
              return (
                <li key={o.key || "all"} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    aria-label={`${o.label}, ${o.count}`}
                    onClick={() => go(o.href)}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-tag ${
                      on ? "font-medium text-ink" : "text-ink-soft"
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[o.key]}`} aria-hidden />
                    <span className="flex-1">{o.label}</span>
                    <span className="rounded-full bg-tag px-2 py-px text-[11px] tabular-nums text-ink-soft">{o.count}</span>
                    <span className={`w-3 text-brand ${on ? "" : "invisible"}`} aria-hidden>
                      ✓
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button type="button" onClick={() => go(addons.href)} aria-pressed={addons.on} className={chip(addons.on)}>
        {addons.on && <span aria-hidden>✓</span>}
        Add-ons only
        <span className="tabular-nums text-ink-faint">{addons.count}</span>
      </button>
    </div>
  );
}
