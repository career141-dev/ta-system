"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Recruiter's prompt strip — a written-out search you can take as it stands.
 *
 * Ours are generated from the database's own vocabulary rather than a fixed
 * list, so every one of them is a search that will actually return people.
 */
export function Suggestion({ lines }: { lines: string[] }) {
  const [i, setI] = useState(0);
  if (lines.length === 0) return null;
  const line = lines[i % lines.length];

  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3">
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0 text-brand">
        <path d="M8 0.5C8.6 4.2 9.5 5.6 12.6 6.6 15.5 7.5 15.5 8.5 12.6 9.4 9.5 10.4 8.6 11.8 8 15.5 7.4 11.8 6.5 10.4 3.4 9.4 0.5 8.5 0.5 7.5 3.4 6.6 6.5 5.6 7.4 4.2 8 0.5Z" fill="currentColor" />
      </svg>
      <Link href={`/database/results?q=${encodeURIComponent(line)}`} className="min-w-0 flex-1 text-[13px] leading-relaxed hover:underline">
        {line}
      </Link>
      <button
        type="button"
        onClick={() => setI((v) => v + 1)}
        className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft"
      >
        <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13 2v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        More
      </button>
    </div>
  );
}
