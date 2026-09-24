"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SearchIcon, CloseIcon } from "./icons";

/** Sent to every ClientCard on the page: open or close them all at once. */
export const CLIENTS_TOGGLE_ALL = "c141:clients-toggle-all";

export interface ClientFilters {
  industry?: string;
}

/**
 * The Clients page's own search, industry filter, and open-all / close-all buttons.
 */
export function ClientsToolbar({
  initialQuery,
  industry,
  industryOptions = [],
}: {
  initialQuery: string;
  industry?: string;
  industryOptions?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndustry, setSelectedIndustry] = useState<string | undefined>(industry);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Keep local selected industry in sync with incoming prop
  useEffect(() => {
    setSelectedIndustry(industry);
  }, [industry]);

  // Sync search input with URL changes (e.g. typing)
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (query.trim()) next.set("q", query.trim());
      else next.delete("q");
      next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Click outside to close filter popover
  useEffect(() => {
    if (!filterOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [filterOpen]);

  const toggleAll = (open: boolean) =>
    window.dispatchEvent(new CustomEvent(CLIENTS_TOGGLE_ALL, { detail: { open } }));

  const setIndustryFilter = (val: string | null) => {
    const nextVal = val && val !== "all" ? val : undefined;
    setSelectedIndustry(nextVal); // Immediate state update for instant label change
    const next = new URLSearchParams(params.toString());
    if (nextVal) {
      next.set("industry", nextVal);
    } else {
      next.delete("industry");
    }
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    setFilterOpen(false);
  };

  const hasIndustryFilter = Boolean(selectedIndustry && selectedIndustry !== "all");

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Open / Close All on the left */}
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => toggleAll(true)}
            className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-rule-strong hover:text-ink"
          >
            Open all
          </button>
          <button
            type="button"
            onClick={() => toggleAll(false)}
            className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-rule-strong hover:text-ink"
          >
            Close all
          </button>
        </div>

        {/* Filter Button & Search Bar grouped together on the right */}
        <div className="ml-auto flex items-center gap-2.5">
          {/* Industry Filter Button & Popover */}
          <div className="relative" ref={filterRef}>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
              aria-label="Filter by industry"
              className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                hasIndustryFilter
                  ? "border-brand bg-brand-soft font-medium text-brand"
                  : "border-rule bg-surface text-ink-soft hover:border-rule-strong hover:text-ink"
              }`}
            >
              <svg
                width={14}
                height={14}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-current"
              >
                <path d="M2 3.5h12M4 8h8M6.5 12.5h3" strokeLinecap="round" />
              </svg>
              <span>{hasIndustryFilter ? `Industry: ${selectedIndustry}` : "Industry"}</span>
            </button>

            {filterOpen && (
              <div className="absolute right-0 top-full z-40 mt-2 w-64 rounded-2xl border border-rule bg-surface p-4 shadow-xl">
                <div className="mb-3 flex items-center justify-between border-b border-rule pb-2.5">
                  <span className="text-[13px] font-semibold text-ink">Filter by Industry</span>
                  {hasIndustryFilter && (
                    <button
                      type="button"
                      onClick={() => setIndustryFilter(null)}
                      className="text-[11.5px] text-ink-soft hover:text-brand hover:underline"
                    >
                      Reset
                    </button>
                  )}
                </div>

                <div>
                  <label className="block text-[11.5px] font-medium text-ink-soft">
                    Select Industry
                  </label>
                  <select
                    value={selectedIndustry ?? "all"}
                    onChange={(e) => setIndustryFilter(e.target.value)}
                    className="mt-1.5 w-full cursor-pointer rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] outline-none transition-colors focus:border-brand"
                  >
                    <option value="all">All industries</option>
                    {industryOptions.map((ind) => (
                      <option key={ind} value={ind}>
                        {ind}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Search Input */}
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search clients"
              aria-label="Search clients"
              className="w-[260px] rounded-full border border-rule bg-surface py-2 pl-9 pr-4 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-line"
            />
          </div>
        </div>
      </div>

      {/* Active Filter Chip */}
      {hasIndustryFilter && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="text-[12px] text-ink-soft">Active filter:</span>
          <button
            type="button"
            onClick={() => setIndustryFilter(null)}
            className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand-soft/60 px-2.5 py-1 text-[12px] font-medium text-brand hover:bg-brand-soft"
          >
            <span>Industry: {selectedIndustry}</span>
            <CloseIcon size={12} />
          </button>
          <button
            type="button"
            onClick={() => setIndustryFilter(null)}
            className="text-[12px] text-ink-soft underline decoration-rule hover:text-ink"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

