"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { runDatabaseSearch } from "@/app/actions";

/**
 * The way in — spec §6D.1, modelled on Recruiter's assisted-search box.
 *
 * One line, a circular send button, the character count under the text. The
 * typeahead offers words the database actually contains: a TA typing
 * "Merchandis" finds out in the same keystroke whether we call it that,
 * "Merchandiser", or "Sourcing".
 *
 * Under the results it is the reply box of a conversation (5 Oct): what is
 * typed is added to the search so far (`prior`), the way a chat carries on,
 * until "New search" starts again. Boolean is a literal string, so it is never
 * added to — switching to it starts a fresh search.
 */
export function SearchBox({
  vocab,
  initialQuery = "",
  initialMode = "natural",
  openingId,
  autoFocus = false,
  compact = false,
  prior = "",
}: {
  vocab: string[];
  initialQuery?: string;
  initialMode?: "natural" | "boolean" | "meaning";
  openingId?: string | null;
  autoFocus?: boolean;
  compact?: boolean;
  /** The conversation so far; set under the results, where the box replies to it. */
  prior?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [mode, setMode] = useState<"natural" | "boolean" | "meaning">(initialMode);
  const [focused, setFocused] = useState(false);
  // A reply adds to the search; a Boolean string stands alone.
  const replying = !!prior && mode !== "boolean" && initialMode !== "boolean";
  const ref = useRef<HTMLTextAreaElement>(null);

  const tail = q.split(/[\s,]+/).pop() ?? "";
  const suggestions = useMemo(() => {
    if (tail.length < 2 || mode === "boolean") return [];
    const t = tail.toLowerCase();
    return vocab.filter((v) => v.toLowerCase().startsWith(t) && v.toLowerCase() !== t).slice(0, 6);
  }, [tail, vocab, mode]);

  const take = (s: string) => {
    const parts = q.split(/([\s,]+)/);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].trim()) {
        parts[i] = s;
        break;
      }
    }
    setQ(parts.join("") + " ");
    ref.current?.focus();
  };

  return (
    <form action={runDatabaseSearch} className="relative">
      <input type="hidden" name="mode" value={mode} />
      {openingId && <input type="hidden" name="openingId" value={openingId} />}
      {replying && <input type="hidden" name="prior" value={prior} />}

      <div
        className={`relative rounded-xl border bg-surface transition-colors ${
          focused ? "border-brand-line shadow-[0_0_0_3px_rgba(22,91,66,0.08)]" : "border-rule-strong"
        }`}
      >
        <textarea
          ref={ref}
          name="q"
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, 4000))}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          autoFocus={autoFocus}
          rows={compact ? 3 : 2}
          placeholder={
            mode === "boolean"
              ? '("Merchandising Manager" OR "Senior Merchandiser") AND "Apparel"'
              : replying
                ? "Refine it — e.g. at least 8 years · knows React · not from Dialog · in Colombo instead"
                : "I'm looking for a…"
          }
          className={`w-full resize-none bg-transparent py-3 ${
            compact ? "px-3.5 pr-3.5 text-[13px]" : "px-4 pr-16 text-[15px]"
          } leading-relaxed outline-none placeholder:text-ink-faint/80`}
        />

        <div className={`flex items-center gap-2.5 ${compact ? "px-3.5" : "px-4"} pb-2.5`}>
          <span className="tabular text-[11.5px] text-ink-faint">
            {q.length.toLocaleString()}/4,000
          </span>
          <div className="ml-auto flex rounded-full bg-tag p-0.5 text-[11px]">
            {(["natural", "meaning", "boolean"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-full px-2.5 py-1 transition-colors ${
                  mode === m
                    ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(23,28,24,0.08)]"
                    : "text-ink-soft hover:text-ink"
                }`}
              >
                {m === "natural" ? "Plain English" : m === "meaning" ? "By meaning" : "Boolean"}
              </button>
            ))}
          </div>
          {compact && (
            <button
              disabled={!q.trim()}
              className="rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {replying ? "Send" : "Search"}
            </button>
          )}
        </div>

        {!compact && (
          <button
            disabled={!q.trim()}
            aria-label="Search"
            className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-brand text-white transition-opacity hover:opacity-90 disabled:bg-rule-strong disabled:opacity-100"
          >
            <svg width={18} height={18} viewBox="0 0 24 24" className="shrink-0" aria-hidden="true">
              <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.1 16 12 3.4 13.9Z" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>

      {prior && (
        <p className="mt-2 flex items-center justify-between gap-3 text-[11.5px] text-ink-faint">
          <span>{replying ? "Each message adds to this search." : "Boolean starts a new search."}</span>
          <Link
            href={`/database${openingId ? `?for=${encodeURIComponent(openingId)}` : ""}`}
            className="shrink-0 font-medium text-accent hover:underline"
          >
            New search
          </Link>
        </p>
      )}

      {focused && suggestions.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1.5 overflow-hidden rounded-xl border border-rule bg-surface py-1 shadow-[0_8px_24px_rgba(23,28,24,0.12)]">
          <li className="px-4 pb-1 pt-1.5 text-[10.5px] uppercase tracking-wider text-ink-faint">
            In the database
          </li>
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => take(s)}
                className="block w-full px-4 py-2 text-left text-[13px] hover:bg-paper"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
