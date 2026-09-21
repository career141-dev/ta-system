"use client";

import Link from "next/link";
import { ChevronIcon, CloseIcon } from "@/components/icons";
import { AddToOpening } from "@/components/AddToOpening";
import { dateAt } from "@/lib/format";
import type { Candidate } from "@/data/types";
import { externalUrl } from "@/lib/url";
import type { RowApp } from "./ResultRow";

/** The open candidate's CV file, as the results page found it. */
export interface DrawerCv {
  /** /api/cv/<candidate>, or null when there is no file to open. */
  href: string | null;
  fileName: string | null;
  /** A PDF, which the browser can show in the panel. */
  inline: boolean;
  /** Why there is no file to show, when there is not. */
  problem: string | null;
}

export function DbCandidateDrawer({
  candidate: c,
  apps,
  openings,
  currentIndex,
  totalCandidates,
  prevHref,
  nextHref,
  closeHref,
  statusLabel,
  cv = null,
}: {
  candidate: Candidate;
  apps: RowApp[];
  openings: { id: string; label: string }[];
  currentIndex: number;
  totalCandidates: number;
  prevHref: string | null;
  nextHref: string | null;
  closeHref: string;
  statusLabel?: string | null;
  cv?: DrawerCv | null;
}) {
  // An opening they are already on is not offered again.
  const onAlready = new Set(apps.map((a) => a.openingId));
  const offered = openings.filter((o) => !onAlready.has(o.id));

  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value || <span className="text-ink-faint">—</span>}</dd>
    </>
  );

  return (
    <>
      {/* Dimmed backdrop over search results */}
      <Link
        href={closeHref}
              scroll={false}
        aria-label="Close"
        className="fixed inset-0 z-40 bg-[#0b1a12]/60"
      />

      {/* Slide-over Drawer panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[1060px] flex-col bg-paper shadow-[-8px_0_40px_rgba(11,26,18,.18)]">
        {/* Top Header Bar */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule bg-surface px-7 py-4">
          <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
            Database Record · {c.fullName}
          </h1>
          <div className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink-soft">
            {prevHref ? (
              <Link
                href={prevHref}
              scroll={false}
                className="grid h-7 w-7 place-items-center rounded hover:bg-tag hover:text-ink"
                title="Previous"
              >
                <ChevronIcon dir="left" />
              </Link>
            ) : (
              <span className="px-1.5 text-ink-faint/50">
                <ChevronIcon dir="left" />
              </span>
            )}
            <span className="tabular">
              {currentIndex + 1} of {totalCandidates}
            </span>
            {nextHref ? (
              <Link
                href={nextHref}
              scroll={false}
                className="grid h-7 w-7 place-items-center rounded hover:bg-tag hover:text-ink"
                title="Next"
              >
                <ChevronIcon dir="right" />
              </Link>
            ) : (
              <span className="px-1.5 text-ink-faint/50">
                <ChevronIcon dir="right" />
              </span>
            )}
            <Link
              href={closeHref}
              scroll={false}
              className="ml-2 grid h-7 w-7 place-items-center rounded hover:bg-tag hover:text-ink"
              title="Close"
            >
              <CloseIcon size={16} />
            </Link>
          </div>
        </header>

        {/* Drawer Body Scroll Container */}
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="flex flex-col gap-6">
            {/* Candidate Header */}
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-[24px] font-semibold tracking-tight">{c.fullName}</h2>
                <p className="mt-1 text-[13px] text-ink-soft">
                  {[c.currentTitle, c.currentEmployer].filter(Boolean).join(" at ") ||
                    "No current role on file"}
                  {c.location && ` · ${c.location}`}
                </p>
                {statusLabel && (
                  <p className="mt-1.5 text-[12.5px] font-medium text-warn">
                    {statusLabel}
                  </p>
                )}
              </div>
              {c.linkedinUrl && (
                <a
                  href={externalUrl(c.linkedinUrl) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12.5px] text-accent hover:underline"
                >
                  LinkedIn profile ↗
                </a>
              )}
            </header>

            {/* Main Content Grid: On file (left) & Openings/Add (right) */}
            <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
              {/* On File Card */}
              <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
                <h3 className="mb-3 text-[13px] font-semibold">On file</h3>
                <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
                  {row("Email", c.email)}
                  {row("Phone", c.phone)}
                  {row(
                    "Experience",
                    c.totalExperienceYears != null ? `${c.totalExperienceYears} years` : null
                  )}
                  {row(
                    "Education",
                    [c.educationDegree, c.educationInstitution].filter(Boolean).join(" — ")
                  )}
                  {row("Qualifications", c.qualifications)}
                  {row("Nationality", c.nationality)}
                  {row("Current salary", c.currentSalary)}
                  {row("Expected salary", c.expectedSalary)}
                  {row(
                    "Notice",
                    c.noticePeriodDays === 0
                      ? "Immediate"
                      : c.noticePeriodDays != null
                        ? `${c.noticePeriodDays} days`
                        : null
                  )}
                  {row("Skills", c.skills.join(", "))}
                  {row("Industries", c.industries.join(", "))}
                  {row("CV", c.cvFileName)}
                </dl>
                {c.workHistory.length > 0 && (
                  <>
                    <h4 className="mb-2 mt-6 text-[13px] font-semibold">Career</h4>
                    <ul className="flex flex-col gap-1.5 text-[12.5px]">
                      {c.workHistory.map((w, i) => (
                        <li key={i}>
                          <span className="text-ink">{w.title}</span>
                          <span className="text-ink-soft"> · {w.employer}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              {/* Right Sidebar: Openings on file & Add to Opening */}
              <aside className="flex flex-col gap-6">
                <section className="rounded-2xl border border-rule bg-surface px-5 py-4">
                  <h3 className="text-[13px] font-semibold">Openings they have been on</h3>
                  {apps.length === 0 ? (
                    <p className="mt-2 text-[12.5px] text-ink-faint">None yet.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-rule">
                      {apps.map((a) => (
                        <li key={a.id} className="py-2 text-[12.5px]">
                          <Link
                            href={`/openings/${a.openingId}/candidate/${a.id}`}
                            className="font-medium hover:underline text-accent"
                          >
                            {a.openingTitle}
                          </Link>
                          <span className="text-ink-soft"> · {a.clientName}</span>
                          <br />
                          <span className="text-ink-faint">
                            {a.stageLabel}
                            {a.lastStageChangedAt ? ` · ${dateAt(a.lastStageChangedAt)}` : ""}
                            {a.rejectReason ? ` · ${a.rejectReason}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Mounted while there is anything to offer, and stays after the last
                    one is used so its answer is still read. Keyed by person, so
                    Previous / Next starts clean. */}
                {openings.length > 0 && <AddToOpening key={c.id} candidateId={c.id} openings={offered} variant="card" />}
              </aside>
            </div>

            {/* The candidate's own CV — the file on record, not a summary of it.
                Keyed by candidate so Previous / Next loads the next person's. */}
            {cv && (
              <section className="overflow-hidden rounded-2xl border border-rule bg-surface">
                <div className="flex flex-wrap items-center gap-3 border-b border-rule px-5 py-3">
                  <h3 className="text-[13px] font-semibold">CV</h3>
                  {cv.fileName && <span className="truncate text-[12px] text-ink-faint">{cv.fileName}</span>}
                  {cv.href && (
                    <div className="ml-auto flex items-center gap-2">
                      <a
                        href={cv.href}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
                      >
                        Open in a new tab
                      </a>
                      <a
                        href={`${cv.href}?download=1`}
                        className="rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
                      >
                        Download
                      </a>
                    </div>
                  )}
                </div>
                {cv.href && cv.inline ? (
                  <iframe key={c.id} src={cv.href} title={`CV — ${c.fullName}`} className="h-[760px] w-full bg-paper" />
                ) : cv.href ? (
                  <p className="px-5 py-10 text-center text-[12.5px] text-ink-soft">
                    This CV is not a PDF, so the browser cannot show it here.{" "}
                    <a href={`${cv.href}?download=1`} className="text-brand hover:underline">
                      Download it
                    </a>
                    .
                  </p>
                ) : (
                  <p className="px-5 py-10 text-center text-[12.5px] text-ink-soft">
                    {cv.problem ?? "No CV file is on record for this candidate."}
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
