"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SearchCriteria } from "@/data/types";
import { criteriaToParams, describe, describeBoolean, parseBoolean, toBooleanString, turnsOf, withoutChip, type Chip } from "@/lib/query";
import { appendSearchTurn, type SearchIntent } from "@/lib/searchIntent";
import type { ReferenceSearchProfile } from "@/lib/referenceSearchProfile";

const KIND_LABEL: Record<string, string> = {
  job_description: "a job description",
  keywords: "keywords",
  name: "a name",
  role: "a role",
};

/** The assistant's small round mark beside each reply. */
function Mark() {
  return (
    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-rule">
      <svg width={14} height={14} viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 text-brand">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M13.5 6.5 8.8 8.8 6.5 13.5 11.2 11.2Z" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * The left rail as a chat (29 Oct): what the TA typed is a bubble, and under it
 * the reply says how many people that message showed. Each message adds to the
 * search before it — "software engineer", then "with 5 years", then "knows Java" —
 * so the counts read down the page as the list narrows. The newest reply also
 * carries the reading, the company rules and the questions worth answering.
 *
 * The reading is the honesty of the whole feature: a search that shows only
 * results asks to be trusted; one that shows its working can be corrected.
 * "Show filters" opens the same reading as removable chips.
 *
 * The conversation scrolls inside the rail and stays at its newest message; the
 * box to reply in is pinned under it by the page.
 */
export function AiPanel({
  criteria,
  ignored,
  query,
  base,
  extra,
  mode,
  total,
  counts = [],
  edited = false,
  read: engineRead = null,
  engineTerms = null,
  kind = null,
  companies = null,
  intent = null,
  referenceProfile = null,
  strongMatches = 0,
  broaderMatches = 0,
}: {
  criteria: SearchCriteria;
  ignored: string[];
  query: string;
  base: string;
  extra: Record<string, string>;
  mode: "natural" | "boolean" | "meaning";
  total: number;
  /** How many people each message showed, oldest first; the last is this list's. */
  counts?: (number | null)[];
  /** The chips in the address were set by hand, so a clarification keeps them. */
  edited?: boolean;
  /** How the matching engine read the sentence, in its own words. Absent when
   *  it did not run — the panel then says only what the parser understood, as
   *  it always has. */
  read?: string | null;
  /** The terms the engine searched on. Absent when it did not run. */
  engineTerms?: string[] | null;
  /** What the search was read as: job_description, keywords, name or role. */
  kind?: string | null;
  /** The companies the engine read out of the conversation (9 Oct). The first
   *  name is the one asked for; the rest are its other spellings. */
  companies?: { names: string[]; scope: "current" | "any"; exclude: string[] } | null;
  /** Recruiter intent memory read from the conversation. */
  intent?: SearchIntent | null;
  referenceProfile?: ReferenceSearchProfile | null;
  strongMatches?: number;
  broaderMatches?: number;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const chips: Chip[] = describe(criteria);
  const boolean = toBooleanString(criteria);
  const bool = mode === "boolean" ? parseBoolean(query) : null;
  const read = bool?.node ? describeBoolean(bool.node) : null;
  const turns = mode === "boolean" ? [query] : turnsOf(query);
  const last = turns.length - 1;

  // Stay on the newest message, whenever a message or its count arrives.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [query, total]);

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
  const clarifyingQuestions = intent
    ? referenceProfile
      ? [
          ...intent.clarifyingQuestions.filter((question) => question.id === "overqualification" || question.id === "seniority_tolerance"),
          ...intent.clarifyingQuestions.filter((question) => question.id !== "overqualification" && question.id !== "seniority_tolerance"),
        ].slice(0, 1)
      : intent.clarifyingQuestions.slice(0, 2)
    : [];
  // A clarification is a reply: it adds a message and carries the counts so far.
  // The chips go with it only when they were set by hand; otherwise they are
  // read again from the sentence, as a typed reply's are.
  const clarificationHref = (turn: string) => {
    const p = edited ? criteriaToParams(criteria) : new URLSearchParams();
    if (edited) p.set("edited", "1");
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    p.set("q", appendSearchTurn(query, turn));
    if (mode !== "natural") p.set("mode", mode);
    if (counts.length) p.set("n", counts.map((c) => c ?? "").join(","));
    return `${base}?${p.toString()}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-3 rounded-xl border border-rule bg-surface px-5 py-3">
        <span className="text-[15px] font-semibold">
          <span className="tabular">{total.toLocaleString()}</span> {total === 1 ? "result" : "results"}
        </span>
        {kind && KIND_LABEL[kind] && (
          <span className="rounded-full bg-tag px-2.5 py-0.5 text-[11px] text-ink-soft" title="How this search was read">
            Read as {KIND_LABEL[kind]}
          </span>
        )}
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="ml-auto text-[12.5px] font-medium text-accent hover:underline"
        >
          {showFilters ? "Hide filters" : "Show filters"}
        </button>
      </div>

      {showFilters && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto rounded-xl border border-rule bg-surface px-5 py-4">
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

      <div
        ref={scroller}
        aria-live="polite"
        aria-label="Search conversation"
        className="max-h-[60vh] min-h-[160px] flex-1 overflow-y-auto overscroll-contain rounded-xl border border-rule bg-surface px-4 py-4 lg:max-h-none"
      >
        <div className="flex flex-col gap-3">
          {turns.map((t, i) => {
            const count = counts[i] ?? null;
            const before = i > 0 ? counts[i - 1] ?? null : null;
            return (
              <Fragment key={i}>
                <p className="ml-auto max-w-[86%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-navactive px-3.5 py-2.5 text-[12.5px] leading-relaxed text-white">
                  {t}
                </p>
                {count !== null && (
                  <div className="flex items-start gap-2">
                    <Mark />
                    <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm bg-paper px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
                      <p>
                        <span className="tabular font-semibold">{count.toLocaleString()}</span>{" "}
                        {count === 1 ? "candidate" : "candidates"}
                        {before !== null && (
                          <span className="text-ink-faint">
                            {" "}
                            · {count === before ? "no change from" : count < before ? "narrowed from" : "widened from"} {before.toLocaleString()}
                          </span>
                        )}
                      </p>

                      {i === last && (
                        <div className="mt-2 flex flex-col gap-2">
                          {/* What it took the sentence to mean. A reading the TA
                              disagrees with is the fastest explanation of a result
                              list that looks wrong. */}
                          {engineRead && !referenceProfile && <p className="text-ink-soft">{engineRead}</p>}
                          {referenceProfile && (
                            <div className="rounded-lg bg-brand-soft px-3 py-2.5">
                              <p>
                                I read the reference as a <span className="font-semibold">{referenceProfile.role}</span>
                                {referenceProfile.totalExperienceYears != null ? ` with about ${referenceProfile.totalExperienceYears} years of experience` : ""}.
                              </p>
                              {referenceProfile.coreSkills.length > 0 && (
                                <p className="mt-1 text-ink-soft">Strongest signals: {referenceProfile.coreSkills.slice(0, 6).join(", ")}.</p>
                              )}
                              <p className="mt-1.5 font-medium">
                                {strongMatches.toLocaleString()} strong {strongMatches === 1 ? "match" : "matches"}
                                {broaderMatches > 0 ? ` · ${broaderMatches.toLocaleString()} broader ${broaderMatches === 1 ? "profile" : "profiles"} available` : ""}
                              </p>
                            </div>
                          )}
                          {/* A company named in the search is a filter (owner,
                              9 Oct), so the panel says so plainly: a TA who sees
                              only Dialog people knows why. */}
                          {companies && companies.names.length > 0 && (
                            <p>
                              Only people who {companies.scope === "current" ? "work at" : "work or worked at"}{" "}
                              <span className="font-semibold">{companies.names[0]}</span>
                              {companies.names.length > 1 && (
                                <span className="text-ink-soft"> (also matched as {companies.names.slice(1).join(", ")})</span>
                              )}
                              .
                            </p>
                          )}
                          {companies && companies.exclude.length > 0 && (
                            <p>
                              Leaving out people at <span className="font-semibold">{companies.exclude.join(", ")}</span> now.
                            </p>
                          )}
                          {intent && intent.summary && !referenceProfile && (
                            <p className="rounded-lg bg-brand-soft px-3 py-2">{intent.summary}</p>
                          )}
                          {!referenceProfile && terms.length > 0 && (
                            <p className="text-[12px] font-semibold">
                              {terms.slice(0, -1).join(", ")}
                              {terms.length > 1 ? ", and " : ""}
                              {terms[terms.length - 1]}
                            </p>
                          )}
                          {clarifyingQuestions.length > 0 && (
                            <div className="rounded-lg border border-rule bg-surface px-3 py-2.5">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Clarify while results stay visible</p>
                              <div className="mt-2 flex flex-col gap-2.5">
                                {clarifyingQuestions.map((question) => (
                                  <div key={question.id}>
                                    <p className="font-medium">{question.label}</p>
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                      {question.options.map((option) => (
                                        <Link
                                          key={option.turn}
                                          href={clarificationHref(option.turn)}
                                          className="rounded-full border border-rule bg-paper px-3 py-1.5 text-[12px] transition-colors hover:border-brand-line hover:text-brand"
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
                          {/* Only where the fixed rules did the reading. The list
                              is what THOSE rules could not place, and saying a
                              word was ignored when the engine in fact searched on
                              it would be false. */}
                          {ignored.length > 0 && !engineRead && (
                            <p className="text-[11.5px] text-ink-faint">
                              Not acted on: {ignored.join(", ")}. Nothing was filtered by those words — if one matters, say it as a title, a skill or a place.
                            </p>
                          )}
                          <p className="text-[11.5px] text-ink-faint">
                            {mode === "boolean"
                              ? "Change it through the box below, or by "
                              : "Add to it in the box below — each message narrows this search — or by "}
                            <button onClick={() => setShowFilters(true)} className="font-medium text-accent hover:underline">
                              editing the current filters
                            </button>
                            .
                          </p>
                          {last === 0 && !referenceProfile && (
                            <details className="text-[11.5px] text-ink-faint">
                              <summary className="cursor-pointer font-medium text-ink-soft hover:text-ink">How this search works</summary>
                              <p className="mt-1.5 leading-relaxed">
                                {mode === "boolean"
                                  ? "Words matched across the whole CV: run the strings you already use on LinkedIn, combine titles with OR and rule companies out with NOT."
                                  : mode === "meaning"
                                    ? "Describe the work, not the words. Similar work under other titles counts, and place, nationality, years, notice and salary stay strict."
                                    : "Describe who you need in words or full sentences, then add or rule out a company, a notice period or a band in the next message."}{" "}
                                {engineRead
                                  ? "A model reads your sentence and searches every CV in the database; the reading it took is above and the filters it applied are always shown."
                                  : "This reads your sentence with fixed rules, not a model, so it can miss things; the filters it applied are always shown."}
                              </p>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
