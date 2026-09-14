"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The one place a page says what just happened.
 *
 * Server actions return to the page they came from with `?msg=` — "7
 * shortlisted", "Only a lead can delete an opening". Eight pages showed it and
 * nineteen did not, so the same refusal was a sentence on one screen and a dead
 * button on the next. This sits under the top bar on every page.
 */
export function Flash() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const msg = params.get("msg");
  const [shown, setShown] = useState(msg);

  useEffect(() => setShown(msg), [msg]);
  if (!shown) return null;

  const dismiss = () => {
    setShown(null);
    const next = new URLSearchParams(params.toString());
    next.delete("msg");
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  return (
    <div role="status" className="mx-auto mt-4 flex max-w-[1180px] items-start gap-3 px-8">
      <p className="flex-1 rounded-xl border border-warn/40 bg-warn-soft px-5 py-3 text-[12.5px] leading-relaxed">
        {shown}
      </p>
      <button onClick={dismiss} aria-label="Dismiss" className="mt-2 px-1 text-[16px] leading-none text-ink-faint hover:text-ink">
        ×
      </button>
    </div>
  );
}
