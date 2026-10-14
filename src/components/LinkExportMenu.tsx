"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toHtmlTable, toTsv } from "@/lib/spreadsheetClipboard";

interface LinkExportMenuProps {
  openingId: string;
  filters: {
    q?: string;
    status?: string;
    level?: number;
    addons?: boolean;
    imark?: boolean;
    by?: string;
  };
  matchingCount: number;
}

export function LinkExportMenu({ openingId, filters, matchingCount }: LinkExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // Construct query string for current filtered view
  const buildQs = (extra: Record<string, string> = {}) => {
    const p: Record<string, string> = {};
    if (filters.q) p.q = filters.q;
    if (filters.status) p.status = filters.status;
    if (filters.level) p.level = String(filters.level);
    if (filters.addons) p.addons = "1";
    if (filters.imark) p.imark = "1";
    if (filters.by) p.by = filters.by;
    for (const [k, v] of Object.entries(extra)) p[k] = v;
    return new URLSearchParams(p).toString();
  };

  const currentQs = buildQs();
  const allQs = buildQs({ all: "1" });

  const handleCopy = () => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/openings/${openingId}/links/export?format=json&${currentQs}`);
        if (!res.ok) throw new Error("Export failed");
        const data = (await res.json()) as { headers: string[]; rows: string[][]; count: number };

        const tsv = toTsv(data.headers, data.rows);
        const html = toHtmlTable(data.headers, data.rows);

        let copiedOk = false;
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          try {
            const item = new ClipboardItem({
              "text/plain": new Blob([tsv], { type: "text/plain" }),
              "text/html": new Blob([html], { type: "text/html" }),
            });
            await navigator.clipboard.write([item]);
            copiedOk = true;
          } catch {
            // fallback below
          }
        }

        if (!copiedOk) {
          await navigator.clipboard.writeText(tsv);
        }

        setCopied(`Copied ${data.count} ${data.count === 1 ? "row" : "rows"}!`);
        setTimeout(() => setCopied(null), 3500);
        setOpen(false);
      } catch (err) {
        console.warn("[LinkExportMenu] Copy error:", err);
        setCopied("Failed to copy");
        setTimeout(() => setCopied(null), 3000);
      }
    });
  };

  return (
    <div ref={boxRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={matchingCount === 0}
        aria-haspopup="true"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-all ${
          matchingCount === 0
            ? "cursor-not-allowed border-rule bg-paper text-ink-faint opacity-50"
            : open
            ? "border-brand bg-brand-soft text-brand shadow-xs"
            : "border-rule bg-surface text-ink-soft hover:border-brand-line hover:text-ink hover:shadow-2xs"
        }`}
        title="Export or copy links into an Excel spreadsheet"
      >
        <svg
          width={13}
          height={13}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-600"
        >
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <path d="M2 6h12M6 2v12" />
        </svg>
        <span>Export</span>
        {copied ? (
          <span className="rounded bg-ok/15 px-1 py-0.2 text-[10.5px] font-semibold text-ok animate-in fade-in">
            {copied}
          </span>
        ) : (
          <svg
            width={10}
            height={10}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-150 ${open ? "rotate-180 text-brand" : "text-ink-faint"}`}
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          className="absolute right-0 z-40 mt-1.5 w-64 origin-top-right rounded-xl border border-rule bg-surface p-1.5 shadow-lg animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="px-2.5 py-1.5 border-b border-rule/60">
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Export Excel Tables</p>
            <p className="text-[11.5px] text-ink-soft">
              {matchingCount} {matchingCount === 1 ? "candidate link" : "candidate links"} selected
            </p>
          </div>

          <div className="py-1">
            {/* 1. Copy for Excel */}
            <button
              type="button"
              role="menuitem"
              onClick={handleCopy}
              disabled={isPending}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-ink hover:bg-brand/5 hover:text-brand transition-colors"
            >
              <svg
                width={15}
                height={15}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0 text-brand"
              >
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M5 11H3.5A1.5 1.5 0 012 9.5v-6A1.5 1.5 0 013.5 2h6A1.5 1.5 0 0111 3.5V5" />
              </svg>
              <div>
                <span className="block font-medium">Copy for Excel</span>
                <span className="block text-[11px] text-ink-faint leading-tight">
                  {isPending ? "Formatting..." : "Paste directly into Excel or Google Sheets"}
                </span>
              </div>
            </button>

            {/* 2. Download Current View .xlsx */}
            <a
              href={`/api/openings/${openingId}/links/export?${currentQs}`}
              download
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-ink hover:bg-brand/5 hover:text-brand transition-colors"
            >
              <svg
                width={15}
                height={15}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0 text-emerald-600"
              >
                <path d="M8 2v9M4 7.5l4 4 4-4M2 13.5h12" />
              </svg>
              <div>
                <span className="block font-medium">Export as Excel file</span>
                <span className="block text-[11px] text-ink-faint leading-tight">
                  Download .xlsx workbook (current view)
                </span>
              </div>
            </a>

            {/* 3. Download All Links .xlsx (if current view is filtered) */}
            {(filters.level || filters.status || filters.addons || filters.imark || filters.by || filters.q) && (
              <a
                href={`/api/openings/${openingId}/links/export?${allQs}`}
                download
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-ink-soft hover:bg-paper hover:text-ink transition-colors border-t border-rule/50 mt-1"
              >
                <svg
                  width={15}
                  height={15}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 shrink-0 text-ink-faint"
                >
                  <path d="M2 4h12M2 8h12M2 12h12" />
                </svg>
                <div>
                  <span className="block font-medium text-[12px]">Export all sheets</span>
                  <span className="block text-[11px] text-ink-faint leading-tight">
                    Every level and status for this job
                  </span>
                </div>
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
