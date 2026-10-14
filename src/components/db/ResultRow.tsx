"use client";

import { ContactLinks } from "@/components/ContactLinks";
import { RowCheck } from "@/components/BulkSelect";
import { packageLine } from "@/lib/format";
import { useState } from "react";
import Link from "next/link";
import { AddToOpening } from "@/components/AddToOpening";
import { FitChip } from "@/components/FitBadge";
import { DoneBadge } from "@/components/SubmitButton";
import { BUTTON } from "@/components/buttonStyles";
import type { Score } from "@/lib/scoring";
import type { CandidateSignal } from "@/lib/match";
import type { Candidate } from "@/data/types";
import { ageHint, ageText } from "@/lib/ageExperience";
import type { RoleEvidence } from "../../../convex/lib/searchRoleEvidence";

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
  selectForm,
  intentEvidence,
  roleEvidence,
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
  /** The results' bulk bar (components/BulkSelect). */
  selectForm?: string;
  /** Search-intent explanation based only on row evidence already shown. */
  intentEvidence?: { matched: string[]; verify: string[]; gaps: string[] };
  roleEvidence?: RoleEvidence;
}) {
  const [allRoles, setAllRoles] = useState(false);
  const [allSkills, setAllSkills] = useState(false);
  const [adding, setAdding] = useState(false);
  const initials = c.fullName.split(" ").map((p) => p[0]).join("").slice(0, 2);
  const live = apps.filter((a) => a.isLive);
  const already = new Set(apps.map((a) => a.openingId));
  const addable = openings.filter((o) => !already.has(o.id));
  const addedTo = openings.filter((o) => already.has(o.id));

  const roles = allRoles ? c.workHistory : c.workHistory.slice(0, 3);
  const matchedSkills = c.skills.filter((s) => hits.some((h) => h.toLowerCase() === s.toLowerCase()));
  const otherSkills = c.skills.filter((s) => !matchedSkills.includes(s));
  const skills = allSkills ? [...matchedSkills, ...otherSkills] : [...matchedSkills, ...otherSkills].slice(0, 3);

  const fallbackHref = `/candidates/${c.id}${backHref ? `?from=${encodeURIComponent(backHref)}` : ""}`;
  const targetLink = candidateHref ?? fallbackHref;

  return (
    <article className="border-b border-rule px-6 py-5 last:border-b-0">
      <div className="flex gap-4">
        {selectForm && (
          <span className="pt-3.5">
            <RowCheck form={selectForm} name="candidateId" value={c.id} label={c.fullName} />
          </span>
        )}
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#c9a227] text-[14px] font-semibold text-white">
          {initials}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            {/* Their record in the platform, opening in a drawer over results or navigating to profile */}
            <Link href={targetLink} scroll={false} className="text-[15px] font-semibold text-accent hover:underline">
              {c.fullName}
            </Link>
            {fit && <FitChip score={fit} />}
          </div>
          <p className="mt-0.5 text-[13px]">
            {c.currentTitle} at {c.currentEmployer}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {/* The location as recorded. ", Sri Lanka" was appended to every
                one, including Dubai. */}
            {[c.location, c.industries.join(", ")].filter(Boolean).join(" · ")}
          </p>

          <dl className="mt-3.5 grid grid-cols-[96px_1fr] gap-x-4 gap-y-2.5">
            {c.age != null && (
              <Line label="Age">
                {ageText(c)}
                {ageHint(c) && <span className="ml-1.5 text-[11.5px] text-ink-faint">{ageHint(c)}</span>}
              </Line>
            )}
            <Line label="Experience">
              <span className="text-ink-soft">{c.totalExperienceYears} years, currently as a {c.currentTitle}</span>
              {c.experienceNote && <span className="block text-[11.5px] text-warn">{c.experienceNote}</span>}
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
              <span>{[c.educationDegree, c.educationInstitution].filter(Boolean).join(" — ") || "Not on file"}</span>
              {/* "English /10 ·" printed on every row whose level was never
                  assessed — only what is known is shown (21 September). */}
              {(c.englishLevel != null || c.languages.length > 0) && (
                <span className="block text-ink-faint">
                  {[c.englishLevel != null ? `English ${c.englishLevel}/10` : null, c.languages.join(", ") || null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
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
                {packageLine(c)}
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

            {roleEvidence && (
              <Line label="Role evidence">
                <span className="text-ink-soft">{roleEvidence.label}{roleEvidence.title ? `: ${roleEvidence.title}` : ""}</span>
              </Line>
            )}

            {misses.length > 0 && (
              <Line label={roleEvidence ? "Verify" : "Missing"}>
                <span className="text-ink-faint">{misses.slice(0, 5).join(", ")}</span>
              </Line>
            )}

            {intentEvidence && (intentEvidence.matched.length > 0 || intentEvidence.verify.length > 0 || intentEvidence.gaps.length > 0) && (
              <Line label="Intent">
                <span className="flex flex-col gap-0.5 text-ink-soft">
                  {intentEvidence.matched.length > 0 && <span><span className="font-medium text-brand">Matched:</span> {intentEvidence.matched.slice(0, 3).join(", ")}</span>}
                  {intentEvidence.verify.length > 0 && <span><span className="font-medium text-warn">Verify:</span> {intentEvidence.verify.slice(0, 2).join(", ")}</span>}
                  {intentEvidence.gaps.length > 0 && <span><span className="font-medium text-ink">Possible gap:</span> {intentEvidence.gaps.slice(0, 3).join(", ")}</span>}
                </span>
              </Line>
            )}
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {/* Where they already are, as a finished state rather than a
                missing button — "Add" becomes "Added" (21 September). */}
            {addedTo.map((o) => (
              <DoneBadge key={o.id} title={`Already on ${o.label}`}>
                Added · {o.label}
              </DoneBadge>
            ))}
            {/* Open first: after the last opening is used, its answer still shows. */}
            {adding ? (
              <AddToOpening
                candidateId={c.id}
                openings={addable}
                variant="compact"
                defaultOpeningId={defaultOpeningId}
                onCancel={() => setAdding(false)}
              />
            ) : addable.length === 0 ? (
              addedTo.length === 0 && (
                <span className="text-[11.5px] text-ink-faint">On every opening you could add them to</span>
              )
            ) : (
              <button type="button" onClick={() => setAdding(true)} className={BUTTON.secondary}>
                {addedTo.length ? "Add to another opening" : "Add to an opening"}
              </button>
            )}
            <ContactLinks
              phone={c.phone}
              email={c.email}
              linkedinUrl={c.linkedinUrl}
              cvHref={c.cvFileName ? `/api/cv/${c.id}` : null}
              className="ml-1"
            />
          </div>
        </div>
      </div>
    </article>
  );
}
