"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PIPELINE_STAGES, CLOSED_STAGES, STAGE_LABEL } from "@/data/types";
import { addJobPost } from "@/app/actions";
import { SignOutButton } from "@clerk/nextjs";
import { RAIL_TOP } from "@/lib/chrome";

export interface SidebarPost {
  id: string;
  title: string;
  status: string;
  count: number;
}

/** One chevron, drawn in the state it means. Rotation of a single glyph is
 *  where "expanded but still pointing right" comes from. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 opacity-60">
      <path
        d={open ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Two sections, as the brief describes: ATS and Headhunting. They are different
 * jobs — one processes people who came to you, the other goes and finds people
 * who did not — so they get separate rails rather than one long list.
 *
 * Pipeline and LinkedIn Job both open into their parts, because in both cases
 * the question is usually "this stage" or "this post", not the whole thing.
 */
export function ProjectSidebar({
  openingId,
  posts,
  canSeeSourcing = true,
}: {
  openingId: string;
  posts: SidebarPost[];
  /** A client contact gets the pipeline from their shortlist on, and none of
   *  the machinery that produced it. */
  canSeeSourcing?: boolean;
}) {
  const path = usePathname();
  const search = useSearchParams();
  const base = `/openings/${openingId}`;
  const jobBase = `${base}/linkedin-job`;
  const inHeadhunting = path.startsWith(`${base}/hh`);
  const inPipeline = path.startsWith(`${base}/pipeline`);
  const inJob = path.startsWith(jobBase);
  const activePost = inJob ? search.get("post") : null;

  const [pipeOpen, setPipeOpen] = useState(inPipeline);
  const [jobOpen, setJobOpen] = useState(inJob);
  const [addingJob, setAddingJob] = useState(false);

  const row = (active: boolean) =>
    `rounded-lg px-3.5 py-2.5 text-[13.5px] transition-colors ${
      active
        ? "bg-navactive font-medium text-white"
        : "text-ink-soft hover:bg-rule/40 hover:text-ink"
    }`;

  const sub = (active: boolean) =>
    `flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] ${
      active ? "font-semibold text-ink" : "text-ink-soft hover:text-ink"
    }`;

  const atsItems = (canSeeSourcing
    ? [
    // Finding 01 — the approved JD had no entry anywhere and its own page
    // redirected away, so the document the whole opening runs on was lost the
    // moment it was signed off.
    { href: `${base}/jd`, label: "Job description" },
    { href: `${base}/database`, label: "Database CVs" },
    { href: `${base}/reference`, label: "Reference" },
    { href: `${base}/snippets`, label: "Snippets" },
    // The Director and client round trips live on the end-of-day email
    // rather than a screen of their own: the set goes out on the email the
    // desk already sends, and the reply to it is what moves people.
    { href: `${base}/eod`, label: "End of day" },
      ]
    : // A client contact reads the shortlist and the job it is for. Nothing else.
      [{ href: `${base}/jd`, label: "Job description" }]);

  // Figma, 12 Sep, plus the 12 Sep review: Research absorbs Benchmarking, the
  // vault is Excel Tables, backups and add-ons live in that table rather than a
  // page of their own, and Boolean strings is gone — it was the same job as
  // Suggestions under a second name.
  const hhItems = [
    { href: `${base}/hh/research`, label: "Research" },
    { href: `${base}/hh/suggestions`, label: "Suggestions" },
    { href: `${base}/hh/links`, label: "Excel Tables" },
  ];

  return (
    <aside
      className="sticky flex w-[238px] shrink-0 flex-col justify-between overflow-y-auto border-r border-rule px-5 py-6"
      style={{ top: RAIL_TOP, height: `calc(100dvh - ${RAIL_TOP}px)` }}
    >
      <div className="flex flex-col gap-1">
        {/* Headhunting is the desk's working-out. A client contact never sees it. */}
        {/* Section switch. Two exact halves, set inline rather than by utility
            class: the default `flex: 1 1 0` still resolves to min-content when
            the item cannot shrink, which is how "Headhunting" ended up sitting
            on top of "ATS". A grid of two equal tracks cannot do that. */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-tag p-1" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Link
            href={base}
            className={`min-w-0 truncate rounded-md py-1.5 text-center text-[12.5px] transition-colors ${
              !inHeadhunting ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-soft hover:text-ink"
            }`}
          >
            ATS
          </Link>
          {canSeeSourcing ? (
            <Link
              href={`${base}/hh`}
              className={`min-w-0 truncate rounded-md py-1.5 text-center text-[12.5px] transition-colors ${
                inHeadhunting ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Headhunting
            </Link>
          ) : (
            <span className="min-w-0 truncate py-1.5 text-center text-[12.5px] text-ink-faint/60">
              Headhunting
            </span>
          )}
        </div>

        {inHeadhunting ? (
          <>
            <Link href={`${base}/hh`} className={row(path === `${base}/hh`)}>
              Overview
            </Link>
            {hhItems.map((i) => (
              <Link key={i.href} href={i.href} className={row(path.startsWith(i.href))}>
                {i.label}
              </Link>
            ))}
          </>
        ) : (
          <>
            <Link href={base} className={row(path === base)}>
              Overview
            </Link>

            <button
              onClick={() => setPipeOpen((v) => !v)}
              className={row(inPipeline && !pipeOpen) + " flex w-full items-center text-left"}
            >
              Pipeline
              <span className="ml-auto">
                <Chevron open={pipeOpen} />
              </span>
            </button>

            {pipeOpen && (
              <div className="mb-1 ml-3.5 flex flex-col gap-0.5 border-l border-rule pl-3">
                {PIPELINE_STAGES.map((s) => (
                  <Link key={s} href={`${base}/pipeline/${s}`} className={sub(path === `${base}/pipeline/${s}`)}>
                    {STAGE_LABEL[s]}
                  </Link>
                ))}
                <div className="my-1.5 border-t border-rule" />
                {CLOSED_STAGES.map((s) => (
                  <Link
                    key={s}
                    href={`${base}/pipeline/${s}`}
                    className={`rounded-md px-2.5 py-[7px] text-[12.5px] ${
                      path === `${base}/pipeline/${s}`
                        ? "font-semibold text-ink"
                        : "text-ink-faint hover:text-ink-soft"
                    }`}
                  >
                    {STAGE_LABEL[s]}
                  </Link>
                ))}
              </div>
            )}

            {/* Posts open the same way the stages do. A TA running three posts
                on one opening is nearly always looking at one of them, not at
                the merged pile — but the merged pile is still the first row,
                because the pool is shared. */}
            <div className={row(inJob && !jobOpen) + " flex w-full items-center justify-between"}>
              <button
                type="button"
                onClick={() => setJobOpen((v) => !v)}
                className="flex-1 text-left"
              >
                LinkedIn Job
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setJobOpen(true);
                    setAddingJob((v) => !v);
                  }}
                  title="Add a job post"
                  aria-label="Add a job post"
                  className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-all ${
                    inJob && !jobOpen
                      ? "border-white/30 bg-white/20 text-white hover:bg-white/30"
                      : "border-rule bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:border-brand hover:bg-brand hover:text-white"
                  }`}
                >
                  + Job
                </button>
                <button
                  type="button"
                  onClick={() => setJobOpen((v) => !v)}
                  aria-label="Toggle LinkedIn Job section"
                  className="grid h-5 w-5 place-items-center rounded opacity-60 transition-opacity hover:opacity-100"
                >
                  <Chevron open={jobOpen} />
                </button>
              </div>
            </div>

            {jobOpen && (
              <div className="mb-1 ml-3.5 flex flex-col gap-0.5 border-l border-rule pl-3">
                {addingJob && (
                  <form
                    action={async (formData) => {
                      setAddingJob(false);
                      await addJobPost(formData);
                    }}
                    className="my-1.5 flex flex-col gap-1.5 rounded-lg border border-rule bg-surface p-2 shadow-sm"
                  >
                    <input type="hidden" name="openingId" value={openingId} />
                    <input
                      name="title"
                      placeholder="Job title..."
                      required
                      autoFocus
                      className="w-full rounded border border-rule bg-paper px-2 py-1 text-[12px] outline-none transition-colors placeholder:text-ink-faint focus:border-brand"
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setAddingJob(false)}
                        className="rounded px-2 py-0.5 text-[11px] text-ink-faint hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="rounded bg-brand px-2.5 py-0.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
                      >
                        Add
                      </button>
                    </div>
                  </form>
                )}
                <Link href={jobBase} className={sub(inJob && !activePost)}>
                  All applicants
                </Link>
                {posts.length === 0 && !addingJob && (
                  <span className="px-2.5 py-[7px] text-[12px] text-ink-faint">No posts yet</span>
                )}
                {posts.map((p) => (
                  <Link
                    key={p.id}
                    href={`${jobBase}?post=${p.id}`}
                    className={sub(activePost === p.id)}
                    title={p.title}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        p.status === "live" ? "bg-brand" : p.status === "paused" ? "bg-warn" : "bg-rule-strong"
                      }`}
                    />
                    <span className="min-w-0 truncate">{p.title}</span>
                    <span className="tabular ml-auto shrink-0 text-[11.5px] text-ink-faint">{p.count}</span>
                  </Link>
                ))}
              </div>
            )}

            {atsItems.map((i) => (
              <Link key={i.href} href={i.href} className={row(path.startsWith(i.href))}>
                {i.label}
              </Link>
            ))}
          </>
        )}
      </div>

      {/* Pinned to the foot of the rail, which is the foot of the window — the
          rail is exactly the space between the context band and the bottom. */}
      <div className="mt-8 flex shrink-0 flex-col gap-1 border-t border-rule pt-3 text-[13px]">
        <a
          href="mailto:uzmaan@career141.com?subject=TA%20platform"
          className="rounded-lg px-3.5 py-2 text-ink-faint transition-colors hover:bg-rule/40 hover:text-ink"
        >
          Help
        </a>
        <SignOutButton redirectUrl="/signin">
          <button className="w-full rounded-lg px-3.5 py-2 text-left text-ink-faint transition-colors hover:bg-rule/40 hover:text-ink">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </aside>
  );
}
