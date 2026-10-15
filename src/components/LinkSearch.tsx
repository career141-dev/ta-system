"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export function LinkSearch({
  openingId,
  q = "",
  baseParams = {},
}: {
  openingId: string;
  q?: string;
  baseParams?: Record<string, string>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(q);
  const [isPending, startTransition] = useTransition();
  const isFirstMount = useRef(true);

  // Sync state if URL prop changes externally
  useEffect(() => {
    setQuery(q);
  }, [q]);

  const updateUrl = (newQuery: string) => {
    const out: Record<string, string> = { ...baseParams };
    delete out.page;
    if (newQuery.trim()) {
      out.q = newQuery.trim();
    } else {
      delete out.q;
    }
    const qs = new URLSearchParams(out).toString();
    const targetUrl = `/openings/${openingId}/hh/links${qs ? `?${qs}` : ""}`;
    startTransition(() => {
      router.replace(targetUrl, { scroll: false });
    });
  };

  // Debounced search sync to URL
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    const timer = setTimeout(() => {
      updateUrl(query);
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="relative min-w-0 flex-1 sm:flex-none">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
        <svg
          className={`h-3.5 w-3.5 transition-colors ${isPending ? "text-brand animate-spin" : "text-ink-faint"}`}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          {isPending ? (
            <path d="M10 2v4m0 8v4M2 10h4m8 0h4" strokeLinecap="round" />
          ) : (
            <>
              <circle cx="9" cy="9" r="6" />
              <path d="M13.5 13.5L18 18" strokeLinecap="round" />
            </>
          )}
        </svg>
      </span>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            updateUrl(query);
          }
        }}
        placeholder="Search in table…"
        aria-label="Search candidates in table"
        className="w-full rounded-full border border-rule bg-surface py-1.5 pl-8 pr-7 text-[12.5px] outline-none placeholder:text-ink-faint transition-colors focus:border-brand-line sm:w-[220px]"
      />
      {query && (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            updateUrl("");
          }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-ink-faint hover:text-ink"
          aria-label="Clear search"
          title="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  );
}
