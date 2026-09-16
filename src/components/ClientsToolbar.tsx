"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "./icons";

/** Sent to every ClientCard on the page: open or close them all at once. */
export const CLIENTS_TOGGLE_ALL = "c141:clients-toggle-all";

/**
 * The Clients page's own search and the open-all / close-all buttons.
 *
 * The search lives on the page rather than in the header, and filters as you
 * type: the list is rendered on the server, so each pause in typing replaces
 * `?q=` and the page re-renders with the matching clients.
 */
export function ClientsToolbar({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const first = useRef(true);

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
    // Only typing drives this; params change as a result of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const toggleAll = (open: boolean) => window.dispatchEvent(new CustomEvent(CLIENTS_TOGGLE_ALL, { detail: { open } }));

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
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
      <div className="relative ml-auto">
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
  );
}
