"use client";

import { useState } from "react";

/** Plain copy, for text meant to be read as well as copied — unlike CopyToken,
 *  which masks what it holds because it holds a secret. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // A denied clipboard is not worth an error state — the text is on
          // screen and can be selected.
        }
      }}
      className="shrink-0 rounded border border-rule px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
