"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { flashTone, type FlashTone } from "@/lib/flashTone";

/**
 * The one place a page says what just happened.
 *
 * Server actions return to the page they came from with `?msg=` — "7
 * shortlisted", "Only a lead can delete an opening". Eight pages showed it and
 * nineteen did not, so the same refusal was a sentence on one screen and a dead
 * button on the next. This sits under the top bar on every page.
 *
 * It floats at the top of the window, green for done, red for refused, amber
 * for in between (21 September). It used to be one amber strip in the page
 * flow: a save that returned you to the same place, scrolled down, showed
 * nothing you could see — so it felt like the button had done nothing — and
 * success and refusal looked identical when you did see it. A success fades
 * after a few seconds; a refusal stays until it is closed, because it asks you
 * to do something.
 */
const LOOK: Record<FlashTone, { box: string; icon: string; label: string }> = {
  ok: { box: "border-brand/40 bg-brand-soft text-brand", icon: "✓", label: "Done" },
  error: { box: "border-danger/40 bg-danger-soft text-danger", icon: "!", label: "Not done" },
  note: { box: "border-warn/40 bg-warn-soft text-warn", icon: "i", label: "Note" },
};

const FADE_AFTER_MS = 6000;

export function Flash() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const msg = params.get("msg");
  const tone = msg ? flashTone(msg, params.get("tone")) : "ok";
  const [shown, setShown] = useState(msg);

  useEffect(() => setShown(msg), [msg]);

  const dismiss = () => {
    setShown(null);
    const next = new URLSearchParams(params.toString());
    next.delete("msg");
    next.delete("tone");
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  useEffect(() => {
    if (!shown || tone !== "ok") return;
    const t = setTimeout(dismiss, FADE_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, tone]);

  if (!shown) return null;
  const look = LOOK[tone];

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+14px)] z-[60] flex justify-center px-4">
      <div
        role={tone === "error" ? "alert" : "status"}
        className={`c141-flash-in pointer-events-auto flex w-full max-w-[640px] items-start gap-3 rounded-xl border px-4 py-3 shadow-[0_8px_28px_rgba(23,28,24,0.16)] ${look.box}`}
      >
        <span
          aria-hidden
          className="mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-current text-[11px] font-bold"
        >
          <span className="text-white">{look.icon}</span>
        </span>
        <p className="flex-1 text-[13px] font-medium leading-relaxed">
          <span className="sr-only">{look.label}: </span>
          {shown}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-mr-1 rounded-md px-1.5 text-[18px] leading-none opacity-70 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2"
        >
          ×
        </button>
      </div>
    </div>
  );
}
