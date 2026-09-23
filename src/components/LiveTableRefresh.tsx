"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the server-rendered page data when:
 * 1. The window / tab gains focus (e.g. switching back from LinkedIn).
 * 2. The document becomes visible.
 *
 * Avoids aggressive setInterval polling to prevent Next.js dev server re-compilation lag.
 */
export function LiveTableRefresh() {
  const router = useRouter();
  const lastRefresh = useRef(0);

  useEffect(() => {
    const trigger = () => {
      const now = Date.now();
      // Debounce: at most once every 2 seconds on tab focus/switch
      if (now - lastRefresh.current < 2000) return;
      lastRefresh.current = now;
      router.refresh();
    };

    const handleFocus = () => {
      trigger();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        trigger();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [router]);

  return null;
}

