"use client";

import { useState } from "react";
import Link from "next/link";
import type { SearchCriteria } from "@/data/types";
import { describe, describeBoolean, parseBoolean, toBooleanString, withoutChip, type Chip } from "@/lib/query";

/**
 * The left rail — spec §6D.2, modelled on Recruiter's AI-assisted search panel.
 *
 * The query comes back as the TA's own sentence in a bubble, then the panel says
 * what it did with it. That reading is the honesty of the whole feature: a search
 * that shows only results asks to be trusted; one that shows its working can be
 * corrected. "Show filters" opens the same reading as removable chips.
 */
export function AiPanel({
  criteria,
  ignored,
  query,
  base,
  extra,
  mode,
  total,
}: {
  criteria: SearchCriteria;
  ignored: string[];
  query: string;
  base: string;
  extra: Record<string, string>;
  mode: "natural" | "boolean" | "meaning";
  total: number;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const chips: Chip[] = describe(criteria);
  const boolean = toBooleanString(criteria);
  const bool = mode === "boolean" ? parseBoolean(query) : null;
  const read = bool?.node ? describeBoolean(bool.node) : null;
  const terms = read
    ? [...read.must, ...read.any.flat()]
    : [...criteria.titles, ...criteria.skills, ...criteria.industries, ...criteria.qualifications];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-xl border border-rule bg-surface px-5 py-3.5">
        <span className="text-[15px] font-semibold">
          <span className="tabular">{total.toLocaleString()}</span> {total === 1 ? "result" : "results"}
        </span>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="ml-auto text-[12.5px] font-medium text-accent hover:underline"
        >
          {showFilters ? "Hide filters" : "Show filters"}
        </button>
      </div>

      {showFilters && (
        <div className="rounded-xl border border-rule bg-surface px-5 py-4">
          <p className="text-[11px] uppercase tracking-wider text-ink-faint">Current filters</p>
          {chips.length === 0 ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              {mode === "boolean"
                ? "Boolean searches match words across the whole CV — there are no numeric filters to edit. Switch to Plain English to apply years, notice or salary."
                : "Nothing narrowed this. Add a title, a place or a number of years."}
            </p>
          ) : (
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <li key={`${c.field}:${c.label}`}>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper py-1 pl-3 pr-1.5 text-[12px]">
                    {c.label}
                    <Link
                      href={`${base}${withoutChip(criteria, c, extra)}`}
                      title={`Drop "${c.label}"`}
                      className="grid h-4 w-4 place-items-center rounded-full text-[11px] leading-none text-ink-faint transition-colors hover:bg-rule hover:text-ink"
                    >
                      ✕
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {boolean && (
            <>
              <p className="mt-4 text-[11px] uppercase tracking-wider text-ink-faint">As boolean</p>
              <p className="mt-1.5 break-words rounded-lg bg-paper px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink-soft">
                {boolean}
              </p>
              <p className="mt-1.5 text-[11px] text-ink-faint">Copy this into LinkedIn Recruiter as-is.</p>
            </>
          )}
        </div>
      )}

      <div className="rounded-xl border border-rule bg-surface px-5 pb-5 pt-4">
        <div className="flex items-start">
          <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" className="mx-auto h-4 w-4 text-brand">
            <path d="M8 0.5C8.6 4.2 9.5 5.6 12.6 6.6 15.5 7.5 15.5 8.5 12.6 9.4 9.5 10.4 8.6 11.8 8 15.5 7.4 11.8 6.5 10.4 3.4 9.4 0.5 8.5 0.5 7.5 3.4 6.6 6.5 5.6 7.4 4.2 8 0.5Z" fill="currentColor" />
          </svg>
        </div>

        <div className="mt-3 flex justify-end">
          <p className="max-w-[86%] rounded-xl rounded-br-sm bg-navactive px-3.5 py-2.5 text-[12.5px] leading-relaxed text-white">
            {query}
          </p>
        </div>

        <div className="mt-5 flex flex-col items-start gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-rule">
            <svg width={16} height={16} viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 text-brand">
              <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M13.5 6.5 8.8 8.8 6.5 13.5 11.2 11.2Z" fill="currentColor" />
            </svg>
          </span>
          <h2 className="text-[13.5px] font-semibold">
            {mode === "boolean" ? "Boolean search" : mode === "meaning" ? "Search by meaning" : "Plain-English search"}
          </h2>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            {mode === "boolean"
              ? "Words matched across the whole CV. Use this chat to:"
              : mode === "meaning"
                ? "Describe the work, not the words. Similar work under other titles counts. Use this to:"
                : "Describe who you need in words or full sentences. Use this to:"}
          </p>
          <ul className="ml-4 list-disc text-[12.5px] leading-relaxed text-ink-soft marker:text-ink-faint">
            {mode === "boolean" ? (
              <>
                <li>Run the strings you already use on LinkedIn</li>
                <li>Combine titles with OR and rule companies out with NOT</li>
                <li>Switch to Plain English for years, notice and salary</li>
              </>
            ) : mode === "meaning" ? (
              <>
                <li>Find people who did the job under a different title</li>
                <li>Keep place, nationality, years, notice and salary strict</li>
                <li>Rank by how close the whole CV is to what you wrote</li>
              </>
            ) : (
              <>
                <li>Search without filling in a form</li>
                <li>Add or remove filters after the fact</li>
                <li>Rule out a company, a notice period or a band</li>
              </>
            )}
          </ul>
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            This reads your sentence with fixed rules, not a model. It can miss things — the filters
            it applied are always shown, and anything it could not use is listed below.
          </p>
        </div>

        <div className="mt-4 rounded-lg bg-paper px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            A search has been started from your request. Update it through the box below, or by{" "}
            <button onClick={() => setShowFilters(true)} className="font-medium text-accent hover:underline">
              editing the current filters
            </button>
            .
          </p>
        </div>

        {terms.length > 0 && (
          <p className="mt-3.5 text-[12.5px] font-semibold leading-relaxed">
            {terms.slice(0, -1).join(", ")}
            {terms.length > 1 ? ", and " : ""}
            {terms[terms.length - 1]}
          </p>
        )}

        {ignored.length > 0 && (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
            Not acted on: {ignored.join(", ")}. Nothing was filtered by those words — if one matters,
            say it as a title, a skill or a place.
          </p>
        )}
      </div>
    </div>
  );
}
