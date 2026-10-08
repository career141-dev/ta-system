"use client";

import { useState } from "react";

/** Copies a phone number or an email, and says it did. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard blocked: the number is still on screen to select.
        }
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-tag hover:text-ink"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}
