"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Re-reads the page every few seconds while it is visible, so progress shows without reloading. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [at, setAt] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setAt(Date.now());
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);

  return (
    <span className="text-[11.5px] text-ink-faint" suppressHydrationWarning>
      Updates every {seconds}s · last {new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}
