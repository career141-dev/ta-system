"use client";

import { useState } from "react";
import Link from "next/link";
import { addToOpening } from "@/app/actions";
import { FitChip } from "@/components/FitBadge";
import type { Score } from "@/lib/scoring";
import type { CandidateSignal } from "@/lib/match";
import type { Candidate } from "@/data/types";
import type { AiHit } from "@/lib/aiSearch";

export interface RowApp {
  id: string;
  openingId: string;
  openingTitle: string;
  clientName: string;
  stageLabel: string;
  ownerName: string | null;
  isLive: boolean;
  lastStageChangedAt?: number;
  rejectReason?: string | null;
}

const TONE: Record<CandidateSignal["tone"], string> = {
  good: "text-brand",
  warn: "text-warn",
  danger: "text-danger",
  quiet: "text-ink-soft",
};

/** A labelled row, the way Recruiter lays a profile out: label left, facts right. */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-px text-[12px] font-semibold text-ink-soft">{label}</dt>
      <dd className="text-[12.5px] leading-relaxed">{children}</dd>
    </>
  );
}

/**
 * One database result — spec §6D.4.
 *
 * The layout is Recruiter's: avatar, name, headline, then Experience / Education
 * / Skills / Availability as labelled rows. The part that is not Recruiter's is
 * Availability, which carries our own history with this person — who is already
 * working them, whether a client has passed, whether we placed them ourselves.
 */
export function ResultRow({
  candidate: c,
  fit,
  hits,
  misses,
  signals,
  apps,
  openings,
  defaultOpeningId,
  backHref,
  candidateHref,
  ai = null,
}: {
  candidate: Candidate;
  /** The same fit score the lists use. Only present when the search is tied
   *  to an opening with an approved JD — there is nothing to fit against
   *  otherwise. */
  fit: Score | null;
  hits: string[];
  misses: string[];
  signals: CandidateSignal[];
  apps: RowApp[];
  openings: { id: string; label: string }[];
  defaultOpeningId: string | null;
  /** The search results URL to return to from the candidate profile. */
  backHref?: string;
  candidateHref?: string;
  /** The AI search's score and reason for this person against the query. */
  ai?: AiHit | null;
}) {
  const [allRoles, setAllRoles] = useState(false);
  const [allSkills, setAllSkills] = useState(false);
  const [adding, setAdding] = useState(false);
  const initials = c.fullName.split(" ").map((p) => p[0]).join("").slice(0, 2);
  const live = apps.filter((a) => a.isLive);
  const already = new Set(apps.map((a) => a.openingId));
  const addable = openings.filter((o) => !already.has(o.id));

  const roles = allRoles ? c.workHistory : c.workHistory.slice(0, 3);
  const matchedSkills = c.skills.filter((s) => hits.some((h) => h.toLowerCase() === s.toLowerCase()));
  const otherSkills = c.skills.filter((s) => !matchedSkills.includes(s));
  const skills = allSkills ? [...matchedSkills, ...otherSkills] : [...matchedSkills, ...otherSkills].slice(0, 3);

  const fallbackHref = `/candidates/${c.id}${backHref ? `?from=${encodeURIComponent(backHref)}` : ""}`;
  const targetLink = candidateHref ?? fallbackHref;

  return (
    <article className="border-b border-rule px-6 py-5 last:border-b-0">
      <div className="flex gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#c9a227] text-[14px] font-semibold text-white">
          {initials}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            {/* Their record in the platform, opening in a drawer over results or navigating to profile */}
            <Link href={targetLink} className="text-[15px] font-semibold text-accent hover:underline">
              {c.fullName}
            </Link>
            {fit && <FitChip score={fit} />}
            {ai && (
              <span
                title={ai.reranked ? "Scored by AI against your search" : "Scored by the matching engine against your search"}
                className={`tabular rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                  ai.score >= 75 ? "bg-brand-soft text-brand" : ai.score >= 50 ? "bg-accent-soft text-accent" : "bg-tag text-ink-soft"
                }`}
              >
                {ai.score}% search match
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[13px]">
            {c.currentTitle} at {c.currentEmployer}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {/* The location as recorded. ", Sri Lanka" was appended to every
                one, including Dubai. */}
            {[c.location, c.industries.join(", ")].filter(Boolean).join(" · ")}
          </p>

          {ai && (
            <div className="mt-2.5 rounded-lg bg-paper/70 px-3 py-2">
              <p className="text-[12.5px] leading-relaxed">
                {ai.reranked && <span className="font-medium text-accent">AI: </span>}
                {ai.reason}
              </p>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-ink-faint">
                <span>Title: {ai.breakdown.title}</span>
                <span>Skills: {ai.breakdown.skills}</span>
                <span>Experience: {ai.breakdown.experience}</span>
                <span>Location: {ai.breakdown.location}</span>
                <span>Industry: {ai.breakdown.industry}</span>
              </p>
            </div>
          )}

          <dl className="mt-3.5 grid grid-cols-[96px_1fr] gap-x-4 gap-y-2.5">
            <Line label="Experience">
              <span className="text-ink-soft">{c.totalExperienceYears} years, currently as a {c.currentTitle}</span>
              <div className="mt-1 flex flex-col gap-0.5">
                {roles.map((r, i) => (
                  <span key={i}>
                    {r.title} at {r.employer}{" "}
                    <span className="tabular italic text-ink-faint">
                      {r.fromYear} – {r.toYear ?? "Present"}
                    </span>
                  </span>
                ))}
              </div>
              {c.workHistory.length > 3 && (
                <button onClick={() => setAllRoles((v) => !v)} className="mt-1 text-[12px] text-accent hover:underline">
                  {allRoles ? "Show less" : `Show all (${c.workHistory.length})`}
                </button>
              )}
            </Line>

            <Line label="Education">
              <span>{c.educationDegree} — {c.educationInstitution}</span>
              <span className="block text-ink-faint">English {c.englishLevel}/10 · {c.languages.join(", ")}</span>
            </Line>

            {skills.length > 0 && (
              <Line label="Skills">
                {skills.map((s, i) => (
                  <span key={s}>
                    <span className={matchedSkills.includes(s) ? "font-medium text-accent" : "text-ink-soft"}>{s}</span>
                    {i < skills.length - 1 && <span className="text-ink-faint"> · </span>}
                  </span>
                ))}
                {c.skills.length > 3 && (
                  <button onClick={() => setAllSkills((v) => !v)} className="ml-2 text-[12px] text-accent hover:underline">
                    {allSkills ? "Show less" : `Show all (${c.skills.length})`}
                  </button>
                )}
              </Line>
            )}

            <Line label="Package">
              <span className="text-ink-soft">
                Now {c.currentSalary} · expects {c.expectedSalary} · {c.noticePeriodDays}-day notice
              </span>
            </Line>

            <Line label="Availability">
              <div className="flex flex-col gap-0.5">
                {signals.map((s) => (
                  <span key={s.kind} className={TONE[s.tone]}>
                    {s.label}
                  </span>
                ))}
                {live.map((a) => (
                  <span key={a.id} className="text-ink-faint">
                    {a.ownerName ? `${a.ownerName} is working them` : "Open"} on{" "}
                    <Link href={`/openings/${a.openingId}/candidate/${a.id}`} className="text-accent hover:underline">
                      {a.openingTitle}
                    </Link>{" "}
                    · {a.clientName} · {a.stageLabel}
                  </span>
                ))}
              </div>
            </Line>

            {misses.length > 0 && (
              <Line label="Missing">
                <span className="text-ink-faint">{misses.slice(0, 5).join(", ")}</span>
              </Line>
            )}
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {addable.length === 0 ? (
              <span className="text-[11.5px] text-ink-faint">On every opening you could add them to</span>
            ) : adding ? (
              <form action={addToOpening} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="candidateId" value={c.id} />
                <div className="relative">
                  <select
                    name="openingId"
                    defaultValue={defaultOpeningId && addable.some((o) => o.id === defaultOpeningId) ? defaultOpeningId : addable[0].id}
                    className="cursor-pointer appearance-none rounded-full border border-rule bg-surface py-1.5 pl-3.5 pr-8 text-[12px] outline-none focus:border-brand"
                  >
                    {addable.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
                    <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <button className="rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90">
                  Add
                </button>
                <button type="button" onClick={() => setAdding(false)} className="px-1.5 text-[12px] text-ink-soft hover:text-ink">
                  Cancel
                </button>
              </form>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
              >
                Add to an opening
              </button>
            )}
            {c.linkedinUrl && (
              <a
                href={c.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-rule px-4 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
              >
                Profile
              </a>
            )}
            <span className="tabular text-[11.5px] text-ink-faint">{c.phone}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
