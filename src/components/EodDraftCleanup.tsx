"use client";

import { useEffect } from "react";

/** Clear only a server-confirmed successful email's browser drafts. */
export function EodDraftCleanup({ keys }: { keys: string[] }) {
  useEffect(() => {
    try {
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      // Storage can be disabled; the accepted email is already safely recorded.
    }
  }, [keys]);
  return null;
}
