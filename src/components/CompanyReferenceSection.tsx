"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getCompanyReferences, type CompanyReferenceColleague } from "@/app/actions";
import { STAGE_LABEL } from "@/data/types";
import { Spinner } from "./Submit";
import { CloseIcon } from "./icons";

const PAGE_SIZE = 6;

/**
 * Company Reference panel (matching Candidate Profile's Company Reference tab).
 * Displays colleagues from the database who work at the same company,
 * providing direct contact numbers and links to their profiles.
 * Shows 6 references initially, expanding by 6 on "View more".
 */
export function CompanyReferenceSection({
  company,
  openingId,
  excludeCandidateId,
  onClose,
  initialColleagues,
  boxed = true,
}: {
  company: string;
  openingId?: string;
  excludeCandidateId?: string | null;
  onClose?: () => void;
  initialColleagues?: CompanyReferenceColleague[];
  boxed?: boolean;
}) {
  const [colleagues, setColleagues] = useState<CompanyReferenceColleague[] | null>(
    initialColleagues ?? null,
  );
  const [loading, setLoading] = useState(!initialColleagues);
  const [problem, setProblem] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    if (initialColleagues) {
      setColleagues(initialColleagues);
      setLoading(false);
      return;
    }
    const clean = (company || "").trim();
    if (!clean) {
      setColleagues([]);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setProblem(null);

    getCompanyReferences({
      company: clean,
      excludeCandidateId,
      openingId,
    })
      .then((res) => {
        if (!active) return;
        if (res.ok) {
          setColleagues(res.colleagues);
        } else {
          setProblem(res.message);
          setColleagues([]);
        }
      })
      .catch((err) => {
        if (!active) return;
        console.warn("[CompanyReferenceSection] Fetch failed:", err);
        setProblem("Could not load company references.");
        setColleagues([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [company, excludeCandidateId, openingId, initialColleagues]);

  const targetCompany = (company || "").trim();
  const total = colleagues?.length ?? 0;
  const shown = colleagues ? colleagues.slice(0, visibleCount) : [];
  const hasMore = total > visibleCount;
  const nextChunk = Math.min(PAGE_SIZE, total - visibleCount);

  return (
    <div className={boxed ? "mt-4 flex flex-col gap-4 rounded-xl border border-rule bg-surface p-4 sm:p-5" : "flex flex-col gap-5"}>
      {/* Header: Company Name, Count and Close Button */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
        <div>
          <span className="text-[12px] font-semibold uppercase tracking-wider text-brand">
            Present Company
          </span>
          <h3 className="mt-0.5 text-[18px] font-bold tracking-tight text-ink">
            {targetCompany || "No employer listed on this profile"}
          </h3>
        </div>

        <div className="flex items-center gap-2.5">
          {colleagues !== null && !loading && (
            <span className="rounded-full bg-tag px-3 py-1 text-[12px] font-medium text-ink">
              {total} {total === 1 ? "person" : "people"} in database
            </span>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1 text-ink-faint transition-colors hover:bg-tag hover:text-ink"
              title="Close Company Reference"
              aria-label="Close Company Reference"
            >
              <CloseIcon size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="flex items-center justify-center gap-2.5 py-10 text-[13px] text-ink-soft">
          <Spinner tone="dark" />
          <span>Searching database for candidates at {targetCompany || "this company"}…</span>
        </div>
      ) : problem ? (
        <div className="py-8 text-center text-[13px] text-danger">{problem}</div>
      ) : !targetCompany ? (
        <div className="py-8 text-center text-[13px] text-ink-faint">
          No company listed on this profile. Edit the row to add an employer name.
        </div>
      ) : colleagues && total === 0 ? (
        <div className="py-8 text-center text-[13px] text-ink-faint">
          No other candidates from <span className="font-medium text-ink-soft">{targetCompany}</span> found in the database.
        </div>
      ) : colleagues && total > 0 ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            {shown.map((colleague) => (
              <div
                key={colleague.id}
                className="flex flex-col justify-between rounded-xl border border-rule bg-paper p-4 transition-colors hover:border-brand-line"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold text-ink">{colleague.fullName}</span>
                    {colleague.latestApp ? (
                      <span className="rounded bg-tag px-1.5 py-0.5 text-[10.5px] text-ink-faint">
                        {STAGE_LABEL[colleague.latestApp.stage as keyof typeof STAGE_LABEL] ?? colleague.latestApp.stage}
                      </span>
                    ) : (
                      <span className="rounded bg-tag px-1.5 py-0.5 text-[10.5px] text-ink-faint">
                        Database Candidate
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[12.5px] font-medium text-ink-soft">
                    {colleague.currentTitle || "Position not listed"}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">
                    {colleague.currentEmployer || targetCompany}
                  </p>
                </div>

                <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-rule/60 pt-2 text-[12px]">
                  <div className="text-ink-soft">
                    {colleague.phone ? (
                      <a
                        href={`tel:${colleague.phone}`}
                        className="tabular mr-2 font-medium text-brand hover:underline"
                      >
                        {colleague.phone}
                      </a>
                    ) : colleague.email ? (
                      <a
                        href={`mailto:${colleague.email}`}
                        className="text-ink-soft hover:underline"
                      >
                        {colleague.email}
                      </a>
                    ) : (
                      <span className="text-ink-faint">No direct contact</span>
                    )}
                  </div>
                  {colleague.latestApp && (
                    <Link
                      href={`/openings/${colleague.latestApp.openingId}/candidate/${colleague.latestApp.id}`}
                      className="font-medium text-brand hover:underline"
                    >
                      View profile →
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Pagination Controls */}
          {total > PAGE_SIZE && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-rule/60 pt-3">
              <span className="text-[12px] text-ink-faint">
                Showing {Math.min(visibleCount, total)} of {total} people
              </span>
              <div className="flex items-center gap-2">
                {hasMore ? (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-brand-line bg-brand-soft px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand hover:text-white"
                  >
                    View more (+{nextChunk})
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setVisibleCount(PAGE_SIZE)}
                    className="rounded-full border border-rule px-3.5 py-1 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
                  >
                    Show less
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
