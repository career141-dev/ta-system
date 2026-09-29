"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * The filter side of Excel Tables' sheet bar (the desk, 29 Sep): which people
 * to show — all, pending, interested, not interested — and add-ons only. The
 * sheets (All, L1, L2…) are the tabs on the other side; these narrow the
 * sheet that is open. Each choice is a link the server worked out, so the
 * address stays the source of truth.
 */
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
  const go = (href: string) => start(() => router.push(href));

  return (
    <div className={`flex items-center gap-3 text-[12.5px] ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <label className="flex items-center gap-1.5 text-ink-soft">
        Show
        <select
          value={status}
          onChange={(e) => go(options.find((o) => o.key === e.target.value)!.href)}
          className="cursor-pointer rounded-md border border-rule bg-surface px-2 py-1 text-[12.5px] text-ink outline-none focus:border-brand"
        >
          {options.map((o) => (
            <option key={o.key || "all"} value={o.key}>
              {o.label} ({o.count})
            </option>
          ))}
        </select>
      </label>
      <label className="flex cursor-pointer items-center gap-1.5 text-ink-soft">
        <input type="checkbox" checked={addons.on} onChange={() => go(addons.href)} className="accent-[var(--color-brand)]" />
        Add-ons only <span className="tabular-nums text-ink-faint">({addons.count})</span>
      </label>
    </div>
  );
}
