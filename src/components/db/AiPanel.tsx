"use client";

import { useState } from "react";
import Link from "next/link";
import type { SearchCriteria } from "@/data/types";
import { criteriaToParams, describe, describeBoolean, parseBoolean, toBooleanString, turnsOf, withoutChip, type Chip } from "@/lib/query";
import { appendSearchTurn, type SearchIntent } from "@/lib/searchIntent";

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
  read: engineRead = null,
  engineTerms = null,
  companies = null,
  intent = null,
}: {
  criteria: SearchCriteria;
  ignored: string[];
  query: string;
  base: string;
  extra: Record<string, string>;
  mode: "natural" | "boolean" | "meaning";
  total: number;
  /** How the matching engine read the sentence, in its own words. Absent when
   *  it did not run — the panel then says only what the parser understood, as
   *  it always has. */
  read?: string | null;
  /** The terms the engine searched on. Absent when it did not run. */
  engineTerms?: string[] | null;
  /** The companies the engine read out of the conversation (9 Oct). The first
   *  name is the one asked for; the rest are its other spellings. */
  companies?: { names: string[]; scope: "current" | "any"; exclude: string[] } | null;
  /** Recruiter intent memory read from the conversation. */
  intent?: SearchIntent | null;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const chips: Chip[] = describe(criteria);
  const boolean = toBooleanString(criteria);
  const bool = mode === "boolean" ? parseBoolean(query) : null;
  const read = bool?.node ? describeBoolean(bool.node) : null;
  /*
   * What the search actually went looking for.
   *
   * Where the engine ran, its own terms — it read the sentence, so these are
   * the words it searched on. The parser's are a worse reading of the same
   * sentence and printing them here would describe a search that did not
   * happen: "Campaign Management and Brand Strategy" comes back from the
   * vocabulary as the single word "Management".
   */
  const terms = read
    ? [...read.must, ...read.any.flat()]
    : engineTerms && engineTerms.length > 0
      ? engineTerms
      : [...criteria.titles, ...criteria.skills, ...criteria.industries, ...criteria.qualifications];
  const clarificationHref = (turn: string) => {
    const p = criteriaToParams(criteria);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    p.set("q", appendSearchTurn(query, turn));
    if (mode !== "natural") p.set("mode", mode);
    return `${base}?${p.toString()}`;
  };

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

        {/* The conversation so far, one bubble per message (5 Oct): the box
            under the results adds to it rather than starting again. */}
        <div className="mt-3 flex flex-col items-end gap-2">
          {(mode === "boolean" ? [query] : turnsOf(query)).map((t, i) => (
            <p
              key={i}
              className="max-w-[86%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-navactive px-3.5 py-2.5 text-[12.5px] leading-relaxed text-white"
            >
              {t}
            </p>
          ))}
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
          {/* What it took the sentence to mean, before the results. A reading
              the TA disagrees with is the fastest explanation of a result list
              that looks wrong. */}
          {engineRead && (
            <p className="rounded-lg bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed text-ink">
              {engineRead}
            </p>
          )}
          {/* A company named in the search is a filter (owner, 9 Oct), so the
              panel says so plainly: a TA who sees only Dialog people knows why. */}
          {companies && companies.names.length > 0 && (
            <p className="text-[12.5px] leading-relaxed text-ink">
              Only people who {companies.scope === "current" ? "work at" : "work or worked at"}{" "}
              <span className="font-semibold">{companies.names[0]}</span>
              {companies.names.length > 1 && (
                <span className="text-ink-soft"> (also matched as {companies.names.slice(1).join(", ")})</span>
              )}
              .
            </p>
          )}
          {companies && companies.exclude.length > 0 && (
            <p className="text-[12.5px] leading-relaxed text-ink">
              Leaving out people at <span className="font-semibold">{companies.exclude.join(", ")}</span> now.
            </p>
          )}
          {intent && intent.summary && (
            <p className="rounded-lg bg-brand-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-ink">
              {intent.summary}
            </p>
          )}
          {intent && intent.clarifyingQuestions.length > 0 && (
            <div className="w-full rounded-lg border border-rule bg-paper px-3.5 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Clarify while results stay visible</p>
              <div className="mt-2.5 flex flex-col gap-3">
                {intent.clarifyingQuestions.slice(0, 2).map((question) => (
                  <div key={question.id}>
                    <p className="text-[12.5px] font-medium leading-relaxed text-ink">{question.label}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {question.options.map((option) => (
                        <Link
                          key={option.turn}
                          href={clarificationHref(option.turn)}
                          className="rounded-full border border-rule bg-surface px-3 py-1.5 text-[12px] transition-colors hover:border-brand-line hover:text-brand"
                        >
                          {option.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
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
            {engineRead
              ? "This reads your sentence with a model and searches every CV in the database — the reading it took is above, and the filters it applied are always shown."
              : "This reads your sentence with fixed rules, not a model. It can miss things — the filters it applied are always shown, and anything it could not use is listed below."}
          </p>
        </div>

        <div className="mt-4 rounded-lg bg-paper px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            {mode === "boolean" ? (
              <>A search has been started from your request. Change it through the box below, or by{" "}</>
            ) : turnsOf(query).length > 1 ? (
              <>These results answer the whole conversation above. Keep refining in the box below — say what to add, change or rule out — or{" "}</>
            ) : (
              <>A search has been started from your request. Keep refining it in the box below, like a chat — each message adds to this search — or by{" "}</>
            )}
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

        {/* Only where the fixed rules did the reading. The list is what THOSE
            rules could not place, and saying a word was ignored when the engine
            in fact searched on it would be false. */}
        {ignored.length > 0 && !engineRead && (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
            Not acted on: {ignored.join(", ")}. Nothing was filtered by those words — if one matters,
            say it as a title, a skill or a place.
          </p>
        )}
      </div>
    </div>
  );
}
