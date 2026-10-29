"use client";

import { useState } from "react";
import { inputClass } from "@/components/form";

/**
 * The Referral Search box (29 Oct). It was one line, which cannot hold a pasted
 * list of names. It grows with what is in it, up to eight lines; Enter searches
 * and Shift+Enter starts a new line, so a list pasted in keeps its lines. Still
 * a plain GET form, so a search has its own address.
 */
export function ReferralSearchBox({ defaultValue, autoFocus }: { defaultValue: string; autoFocus: boolean }) {
  const [text, setText] = useState(defaultValue);
  return (
    <form method="GET" action="/database/referral" className="flex items-start gap-2">
      <textarea
        name="q"
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 4000))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        rows={1}
        maxLength={4000}
        autoFocus={autoFocus}
        placeholder="e.g. HR Managers at Dialog — or paste a list of names, one per line, to see who we already hold"
        className={`${inputClass} max-h-48 min-h-[42px] resize-none leading-relaxed [field-sizing:content]`}
        aria-label="Referral search"
      />
      <button className="h-[42px] shrink-0 rounded-lg bg-brand px-5 text-[13px] font-medium text-white transition-opacity hover:opacity-90">Search</button>
    </form>
  );
}
