"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Scope switcher on the Alerts page ("Just mine" vs "All alerts") for Admin and TA Leads.
 *
 * Provides a clean segmented toggle and immediate visual feedback (loading spinner
 * and disabled state) while Next.js routes to the selected scope.
 */
export function AlertsScopeToggle({
  isEveryone,
  q = "",
  view,
}: {
  isEveryone: boolean;
  q?: string;
  view?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingTarget, setPendingTarget] = useState<"mine" | "everyone" | null>(null);

  const handleSwitch = (target: "mine" | "everyone") => {
    if ((target === "everyone" && isEveryone) || (target === "mine" && !isEveryone)) {
      return;
    }
    const params = new URLSearchParams();
    if (target === "everyone") params.set("all", "1");
    if (view && view !== "all") params.set("view", view);
    if (q) params.set("q", q);
    const qs = params.toString();
    const targetHref = qs ? `/alerts?${qs}` : "/alerts";

    setPendingTarget(target);
    startTransition(() => {
      router.push(targetHref);
    });
  };

  return (
    <div
      role="group"
      aria-label="Alerts view scope"
      className="inline-flex items-center rounded-full border border-rule bg-surface p-1 shadow-xs"
    >
      <button
        type="button"
        onClick={() => handleSwitch("mine")}
        disabled={isPending}
        className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all ${
          !isEveryone
            ? "bg-navactive text-white shadow-xs"
            : "text-ink-soft hover:bg-paper hover:text-ink cursor-pointer"
        } ${isPending && pendingTarget === "mine" ? "opacity-80" : ""}`}
      >
        {isPending && pendingTarget === "mine" ? (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
        ) : null}
        <span>Just mine</span>
      </button>

      <button
        type="button"
        onClick={() => handleSwitch("everyone")}
        disabled={isPending}
        className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all ${
          isEveryone
            ? "bg-navactive text-white shadow-xs"
            : "text-ink-soft hover:bg-paper hover:text-ink cursor-pointer"
        } ${isPending && pendingTarget === "everyone" ? "opacity-80" : ""}`}
      >
        {isPending && pendingTarget === "everyone" ? (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
        ) : null}
        <span>All alerts</span>
      </button>
    </div>
  );
}
