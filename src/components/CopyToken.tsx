"use client";

import { useState } from "react";

/** Shown masked, because it is a key and this page is often on a shared screen. */
export function CopyToken({ token }: { token: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-lg border border-rule bg-paper px-3 py-2 text-[11.5px]">
        {shown ? token : "•".repeat(24)}
      </code>
      <button
        onClick={() => setShown((v) => !v)}
        className="shrink-0 rounded-lg border border-rule px-2.5 py-2 text-[11.5px] text-ink-soft hover:text-ink"
      >
        {shown ? "Hide" : "Show"}
      </button>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(token);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="shrink-0 rounded-lg bg-brand px-3 py-2 text-[11.5px] font-medium text-white hover:opacity-90"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
