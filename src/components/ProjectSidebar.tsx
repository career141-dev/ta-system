"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { PIPELINE_STAGES, CLOSED_STAGES, STAGE_LABEL } from "@/data/types";
import { addJobPost, addLinkLevel, deleteJobPost } from "@/app/actions";
import { SignOut } from "./SignOut";
import { SubmitButton } from "./Submit";
import { LinkLevelItem } from "./LinkLevelItem";
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
  levels = [],
  nextLevel = 1,
  canSeeSourcing = true,
}: {
  openingId: string;
  posts: SidebarPost[];
  /** The viewer's L's under Excel Tables, started with its + (29 Sep). */
  levels?: { n: number; label: string; name: string; count: number }[];
  /** What the + starts next — numbers are not reused after a delete. */
  nextLevel?: number;
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
  // On a phone the rail is a menu above the page, closed until asked for and
  // closed again once a page is picked (5 Oct, mobile).
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => setRailOpen(false), [path, search]);

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
    { href: `${base}/snippets`, label: "Snippets" },
    // What the TA Lead asked this TA to try on the job (Strategy Planner, 8 Oct).
    { href: `${base}/strategies`, label: "Strategies" },
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
    <>
    <button
      type="button"
      onClick={() => setRailOpen((v) => !v)}
      aria-expanded={railOpen}
      className="flex items-center justify-between border-b border-rule bg-surface px-4 py-3 text-[13.5px] font-medium text-ink sm:px-6 lg:hidden"
    >
      <span>{railOpen ? "Close menu" : "Pipeline, posts and tools"}</span>
      <Chevron open={railOpen} />
    </button>
    <aside
      className={`${railOpen ? "flex" : "hidden"} w-full shrink-0 flex-col justify-between overflow-y-auto border-b border-rule bg-surface px-4 py-5 sm:px-6 lg:sticky lg:flex lg:w-[238px] lg:border-b-0 lg:border-r lg:bg-transparent lg:px-5 lg:py-6 lg:[height:calc(100dvh-var(--rail-top))] lg:[top:var(--rail-top)]`}
      style={{ ["--rail-top" as string]: RAIL_TOP }}
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
            {hhItems.map((i) =>
              i.label !== "Excel Tables" ? (
                <Link key={i.href} href={i.href} className={row(path.startsWith(i.href))}>
                  {i.label}
                </Link>
              ) : (
                <Fragment key={i.href}>
                  {/* Excel Tables, with + to start the TA's next L (L1, then
                      L2…) and their L's listed under it (the desk, 29 Sep). */}
                  <div className={row(path.startsWith(i.href) && !search.get("level")) + " flex items-center justify-between"}>
                    <Link href={i.href} className="flex-1">
                      {i.label}
                    </Link>
                    <form action={addLinkLevel}>
                      <input type="hidden" name="openingId" value={openingId} />
                      <SubmitButton
                        title={`Start L${nextLevel}`}
                        aria-label={`Start L${nextLevel}`}
                        pendingLabel="…"
                        className={`grid h-5 w-5 place-items-center rounded-md border text-[13px] font-semibold leading-none transition-all ${
                          path.startsWith(i.href) && !search.get("level")
                            ? "border-white/30 bg-white/20 text-white hover:bg-white/30"
                            : "border-rule bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:border-brand hover:bg-brand hover:text-white"
                        }`}
                      >
                        +
                      </SubmitButton>
                    </form>
                  </div>
                  {levels.length > 0 && (
                    <div className="mb-1 ml-3.5 flex flex-col gap-0.5 border-l border-rule pl-3">
                      {levels.map((l) => {
                        const on = path.startsWith(i.href) && search.get("level") === String(l.n);
                        return (
                          <LinkLevelItem
                            key={l.n}
                            openingId={openingId}
                            href={`${i.href}?level=${l.n}`}
                            level={l}
                            active={on}
                            className={sub(on)}
                          />
                        );
                      })}
                    </div>
                  )}
                </Fragment>
              ),
            )}
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

            {/* The CVs a lead sent the TA, uploaded here (29 Sep) — this
                replaced reading each TA's mailbox for them. */}
            {canSeeSourcing && (
              <Link href={`${base}/scoops`} className={row(path.startsWith(`${base}/scoops`))}>
                Scoops
              </Link>
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
                  className={`grid h-5 w-5 place-items-center rounded-md border text-[13px] font-semibold leading-none transition-all ${
                    inJob && !jobOpen
                      ? "border-white/30 bg-white/20 text-white hover:bg-white/30"
                      : "border-rule bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:border-brand hover:bg-brand hover:text-white"
                  }`}
                >
                  +
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
                    action={addJobPost}
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
                    <input
                      name="externalUrl"
                      type="url"
                      placeholder="LinkedIn Recruiter link (talent/hire/…)"
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
                      <SubmitButton
                        pendingLabel="Adding…"
                        onDone={() => setAddingJob(false)}
                        className="rounded bg-brand px-2.5 py-0.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                      >
                        Add
                      </SubmitButton>
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
                  <div
                    key={p.id}
                    className={`group flex items-center justify-between gap-1.5 rounded-md px-2.5 py-[6px] text-[12.5px] transition-colors ${
                      activePost === p.id
                        ? "bg-rule/40 font-semibold text-ink"
                        : "text-ink-soft hover:bg-rule/20 hover:text-ink"
                    }`}
                  >
                    <Link
                      href={`${jobBase}?post=${p.id}`}
                      className="flex min-w-0 flex-1 items-center gap-2"
                      title={p.title}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          p.status === "live"
                            ? "bg-brand"
                            : p.status === "paused"
                              ? "bg-warn"
                              : "bg-rule-strong"
                        }`}
                      />
                      <span className="min-w-0 truncate">{p.title}</span>
                    </Link>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="tabular text-[11.5px] text-ink-faint group-hover:hidden">
                        {p.count}
                      </span>
                      <form
                        action={async (formData) => {
                          await deleteJobPost(formData);
                        }}
                        onSubmit={(e) => {
                          if (!window.confirm(`Delete job post "${p.title}"?`)) {
                            e.preventDefault();
                          }
                        }}
                        className="hidden group-hover:block [@media(hover:none)]:block"
                      >
                        <input type="hidden" name="openingId" value={openingId} />
                        <input type="hidden" name="postId" value={p.id} />
                        <SubmitButton
                          tone="dark"
                          title={`Delete post "${p.title}"`}
                          aria-label={`Delete post "${p.title}"`}
                          className="rounded p-0.5 text-danger transition-colors hover:bg-danger-soft hover:opacity-80 disabled:opacity-60"
                        >
                          <svg
                            width={13}
                            height={13}
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path
                              d="M3 4.5h10M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6 7.5v5M10 7.5v5M4 4.5l.8 9.2a1 1 0 0 0 1 .8h4.4a1 1 0 0 0 1-.8l.8-9.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </SubmitButton>
                      </form>
                    </div>
                  </div>
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
        <SignOut className="w-full rounded-lg px-3.5 py-2 text-left text-ink-faint transition-colors hover:bg-rule/40 hover:text-ink" />
      </div>
    </aside>
    </>
  );
}
