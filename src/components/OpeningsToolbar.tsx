"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SearchIcon, CloseIcon } from "./icons";

export interface OpeningsFilterValues {
  location?: string;
  industry?: string;
  clientId?: string;
  taId?: string;
}

export interface BucketItem {
  key: string;
  label: string;
  count: number;
}

export function OpeningsToolbar({
  initialQuery,
  currentBucket,
  buckets,
  filters = {},
  locationOptions = [],
  industryOptions = [],
  clientOptions = [],
  taOptions = [],
  showTaFilter = false,
}: {
  initialQuery: string;
  currentBucket: string;
  buckets: BucketItem[];
  filters?: OpeningsFilterValues;
  locationOptions?: string[];
  industryOptions?: string[];
  clientOptions?: { id: string; name: string }[];
  taOptions?: { id: string; name: string }[];
  showTaFilter?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const [selectedFilters, setSelectedFilters] = useState<OpeningsFilterValues>(filters);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Keep local filters in sync with incoming props
  useEffect(() => {
    setSelectedFilters(filters);
  }, [filters.location, filters.industry, filters.clientId, filters.taId]);

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

  const setFilter = (key: keyof OpeningsFilterValues, value: string | null) => {
    const nextVal = value && value !== "all" ? value : undefined;
    
    // Instant local state update for quick UI label reaction
    setSelectedFilters((prev) => ({
      ...prev,
      [key]: nextVal,
    }));

    const next = new URLSearchParams(params.toString());
    if (nextVal) {
      next.set(key, nextVal);
    } else {
      next.delete(key);
    }
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const clearAllFilters = () => {
    setSelectedFilters({});
    const next = new URLSearchParams(params.toString());
    next.delete("location");
    next.delete("industry");
    next.delete("clientId");
    next.delete("taId");
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const activeFilterEntries = Object.entries(selectedFilters).filter(
    ([k, v]) => v && v !== "all" && (k !== "taId" || showTaFilter)
  ) as [keyof OpeningsFilterValues, string][];
  const activeCount = activeFilterEntries.length;

  const filterLabel = (key: keyof OpeningsFilterValues, val: string): string => {
    if (key === "clientId") {
      const c = clientOptions.find((x) => x.id === val);
      return `Client: ${c?.name ?? val}`;
    }
    if (key === "location") return `Country: ${val}`;
    if (key === "industry") return `Industry: ${val}`;
    if (key === "taId") {
      const t = taOptions.find((x) => x.id === val);
      return `TA: ${t?.name ?? val}`;
    }
    return `${key}: ${val}`;
  };

  // Dynamically compute the button title for immediate feedback
  const getButtonLabel = (): string => {
    if (activeCount === 0) return "Filter";
    if (activeCount === 1) {
      const [key, val] = activeFilterEntries[0];
      if (key === "location") return val; // e.g. "Pakistan" or "Sri Lanka"
      if (key === "clientId") {
        const c = clientOptions.find((x) => x.id === val);
        return c?.name ?? "Client";
      }
      if (key === "industry") return val;
      if (key === "taId") {
        const t = taOptions.find((x) => x.id === val);
        return t?.name ?? "TA";
      }
    }
    return `Filters (${activeCount})`;
  };

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Bucket selection tabs on the left */}
        <div className="flex flex-wrap gap-1.5">
          {buckets.map((b) => {
            const next = new URLSearchParams(params.toString());
            next.set("bucket", b.key);
            next.delete("page");
            const qs = next.toString();
            const href = qs ? `${pathname}?${qs}` : pathname;
            const isSelected = b.key === currentBucket;

            return (
              <Link
                key={b.key}
                href={href}
                className={`rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                  isSelected
                    ? "border-navactive bg-navactive text-white"
                    : "border-rule bg-surface text-ink-soft hover:border-rule-strong hover:text-ink"
                }`}
              >
                {b.label}
                <span
                  className={`tabular ml-1.5 ${
                    isSelected ? "text-white/60" : "text-ink-faint"
                  }`}
                >
                  {b.count}
                </span>
              </Link>
            );
          })}
        </div>

        {/* Filter Button & Search Input grouped together on the right */}
        <div className="flex w-full items-center gap-2.5 sm:ml-auto sm:w-auto">
          {/* Filter Button & Popover */}
          <div className="relative" ref={filterRef}>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
              aria-label="Filter openings"
              className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                activeCount > 0
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
              <span>{getButtonLabel()}</span>
              {activeCount > 1 && (
                <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10.5px] font-semibold text-white">
                  {activeCount}
                </span>
              )}
            </button>

            {filterOpen && (
              <div className="absolute left-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-32px)] rounded-2xl sm:left-auto sm:right-0 border border-rule bg-surface p-4 shadow-xl">
                <div className="mb-3 flex items-center justify-between border-b border-rule pb-2.5">
                  <span className="text-[13px] font-semibold text-ink">Filter Openings</span>
                  {activeCount > 0 && (
                    <button
                      type="button"
                      onClick={clearAllFilters}
                      className="text-[11.5px] text-ink-soft hover:text-brand hover:underline"
                    >
                      Reset all
                    </button>
                  )}
                </div>

                <div className="space-y-3.5">
                  {/* 1. Client Filter (1st) */}
                  <div>
                    <label className="block text-[11.5px] font-medium text-ink-soft">
                      Client
                    </label>
                    <select
                      value={selectedFilters.clientId ?? "all"}
                      onChange={(e) => setFilter("clientId", e.target.value)}
                      className="mt-1 w-full cursor-pointer rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[12.5px] outline-none transition-colors focus:border-brand"
                    >
                      <option value="all">All clients</option>
                      {clientOptions.map((cl) => (
                        <option key={cl.id} value={cl.id}>
                          {cl.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 2. Country Filter (2nd) */}
                  <div>
                    <label className="block text-[11.5px] font-medium text-ink-soft">
                      Country
                    </label>
                    <select
                      value={selectedFilters.location ?? "all"}
                      onChange={(e) => setFilter("location", e.target.value)}
                      className="mt-1 w-full cursor-pointer rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[12.5px] outline-none transition-colors focus:border-brand"
                    >
                      <option value="all">All countries</option>
                      {locationOptions.map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 3. Industry Filter (3rd) */}
                  <div>
                    <label className="block text-[11.5px] font-medium text-ink-soft">
                      Industry
                    </label>
                    <select
                      value={selectedFilters.industry ?? "all"}
                      onChange={(e) => setFilter("industry", e.target.value)}
                      className="mt-1 w-full cursor-pointer rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[12.5px] outline-none transition-colors focus:border-brand"
                    >
                      <option value="all">All industries</option>
                      {industryOptions.map((ind) => (
                        <option key={ind} value={ind}>
                          {ind}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 4. TA Name Filter (4th - for Lead, Admin, Director, Ops) */}
                  {showTaFilter && taOptions.length > 0 && (
                    <div>
                      <label className="block text-[11.5px] font-medium text-ink-soft">
                        Assigned TA
                      </label>
                      <select
                        value={selectedFilters.taId ?? "all"}
                        onChange={(e) => setFilter("taId", e.target.value)}
                        className="mt-1 w-full cursor-pointer rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[12.5px] outline-none transition-colors focus:border-brand"
                      >
                        <option value="all">All TAs</option>
                        {taOptions.map((ta) => (
                          <option key={ta.id} value={ta.id}>
                            {ta.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Search Input */}
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search openings"
              aria-label="Search openings"
              className="w-full rounded-full border border-rule bg-surface py-2 pl-9 sm:w-[260px] pr-4 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-line"
            />
          </div>
        </div>
      </div>

      {/* Active Filter Chips */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="text-[12px] text-ink-soft">Active filters:</span>
          {activeFilterEntries.map(([k, v]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k, null)}
              className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand-soft/60 px-2.5 py-1 text-[12px] font-medium text-brand hover:bg-brand-soft"
            >
              <span>{filterLabel(k, v)}</span>
              <CloseIcon size={12} />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAllFilters}
            className="text-[12px] text-ink-soft underline decoration-rule hover:text-ink"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
