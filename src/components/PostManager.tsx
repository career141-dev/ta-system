"use client";

import { useState } from "react";
import { addJobPost, deleteJobPost, setPostStatus, testPostRouteInline, transferCvs, updatePost } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";
import { TokenInput, inputClass } from "./form";
import { Confirm } from "./Confirm";
import type { JobPost, User } from "@/data/types";
import { isTa } from "@/lib/auth";

const STATUS_LABEL: Record<JobPost["status"], string> = {
  draft: "Draft",
  live: "Live",
  paused: "Paused",
  closed: "Closed",
};

/**
 * Posts live inside the Opening (Q20). Two mechanisms matter here and both are
 * easy to lose in a generic CRUD screen:
 *
 * Alias keywords — when a recruiter renames a post to beat candidate fatigue,
 * the old title has to keep routing, or the rename silently orphans every
 * application that still quotes it.
 *
 * CV transfer — a paused post's CVs move to the live one in one action, rather
 * than being re-sourced.
 */
export function PostManager({
  openingId,
  posts,
  users,
  countsByPost,
  bare = false,
}: {
  openingId: string;
  posts: JobPost[];
  users: User[];
  countsByPost: Record<string, number>;
  /** Sitting behind a disclosure that already names it — so it drops its own
   *  card, heading and blurb and is just the controls. */
  bare?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [transferFrom, setTransferFrom] = useState<string | null>(null);

  const live = posts.filter((p) => p.status === "live");

  return (
    <section className={bare ? "" : "rounded-2xl border border-rule bg-surface"}>
      <header
        className={`flex flex-wrap items-center justify-between gap-4 ${
          bare ? "pb-4" : "border-b border-rule px-7 py-6"
        }`}
      >
        {bare ? (
          <span className="text-[12px] text-ink-faint">
            {live.length} live of {posts.length}
          </span>
        ) : (
          <div>
            <h2 className="text-[15px] font-semibold">Posts</h2>
            <p className="mt-1 text-[12.5px] text-ink-soft">
              Many posts, one candidate pool. {live.length} live of {posts.length}.
            </p>
          </div>
        )}
        <button
          onClick={() => setAdding((v) => !v)}
          className={
            bare
              ? "text-[12.5px] text-brand hover:underline"
              : "flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft"
          }
        >
          {adding ? "Cancel" : "Add a post"}
        </button>
      </header>

      {adding && (
        <form action={addJobPost} className="border-b border-rule bg-paper/60 px-7 py-6">
          <input type="hidden" name="openingId" value={openingId} />
          <h3 className="mb-4 text-[13.5px] font-semibold">New post</h3>
          <div className="flex flex-wrap items-end gap-4">
            <label className="min-w-[280px] flex-1">
              <span className="mb-1.5 block text-[12px] text-ink-soft">Title candidates will see</span>
              <input
                name="title"
                required
                autoFocus
                placeholder="GM Merchandising"
                className={`${inputClass} text-[15px]`}
              />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Where it is posted</span>
              <select name="channel" defaultValue="linkedin" className={`${inputClass} cursor-pointer`}>
                <option value="linkedin">LinkedIn job</option>
                <option value="facebook">Meta campaign (WhatsApp)</option>
                <option value="email_campaign">Email campaign</option>
              </select>
            </label>
            <label className="flex items-center gap-2 pb-2.5">
              <input
                type="checkbox"
                name="liveOnLinkedIn"
                value="1"
                defaultChecked
                className="h-4 w-4"
              />
              <span className="text-[12.5px]">It is live now</span>
            </label>
            <SubmitButton
              pendingLabel="Creating…"
              className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              Create post
            </SubmitButton>
          </div>
          <p className="mt-3 max-w-[78ch] text-[11.5px] leading-relaxed text-ink-faint">
            <strong className="font-medium text-ink-soft">LinkedIn:</strong> put the owner&rsquo;s
            applications inbox into the job setup, where LinkedIn emails applicants to. Each
            application is filed to this post by its headline.{" "}
            <strong className="font-medium text-ink-soft">Meta or email campaign:</strong> the post
            gets a short code once created. Put it in the ad&rsquo;s pre-filled WhatsApp message, or
            ask for it in the email subject, and replies carrying it are filed here. Only live posts
            are filed to or chased.
          </p>
        </form>
      )}

      <RouteTester openingId={openingId} bare={bare} />

      <div className="divide-y divide-rule">
        {posts.length === 0 && (
          <p className="px-7 py-12 text-center text-[13px] text-ink-faint">
            No posts yet. Add one to start collecting applications.
          </p>
        )}

        {posts.map((p) => {
          const ta = users.find((u) => u.id === p.assignedTaId);
          const isEditing = editing === p.id;
          const count = countsByPost[p.id] ?? 0;

          return (
            <div key={p.id} className="px-7 py-6">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[15px] font-medium">{p.title}</span>
                    <span
                      className={`rounded-md px-2 py-[3px] text-[11px] font-medium ${
                        p.status === "live"
                          ? "bg-brand-soft text-brand"
                          : p.status === "paused"
                            ? "bg-warn-soft text-warn"
                            : "bg-tag text-ink-soft"
                      }`}
                    >
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-soft">
                    <span>{[p.city, p.country].filter(Boolean).join(", ") || "No region set"}</span>
                    <span className="text-ink-faint">·</span>
                    <span>{ta?.name ?? "Unassigned"}</span>
                    {/*
                      For now applications arrive at the desk's shared
                      mailboxes (linkedin@, cv@) and are filed to a post by its
                      LinkedIn job link, then its title, old titles and aliases
                      (22 September). A TA's own applications mailbox, once set
                      on People, is shown too — it is where their adverts will
                      point next.
                    */}
                    {ta?.routingEmail && (
                      <code className="rounded-md bg-paper px-2 py-1 text-[11.5px] text-ink-soft">
                        {ta.routingEmail}
                      </code>
                    )}
                    {p.externalUrl ? (
                      <a href={p.externalUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                        LinkedIn link
                      </a>
                    ) : (
                      p.channel === "linkedin" && (
                        // Loud on purpose: without the link a CV is filed by title alone, and
                        // the same title on two openings files it to both (24 September).
                        <span className="rounded-md bg-warn-soft px-2 py-[3px] text-[11.5px] font-medium text-warn">
                          No LinkedIn link — paste the job's LinkedIn Recruiter link, or CVs may go to the wrong job
                        </span>
                      )
                    )}
                  </div>

                  {/* A campaign post is found by its code, so the code and
                      where it goes are shown on the post itself. */}
                  {(p.channel === "facebook" || p.channel === "email_campaign") && (
                    <div className="mt-2.5 rounded-lg border border-rule bg-paper/60 px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
                      <span className="mr-2 font-medium text-ink">
                        {p.channel === "facebook" ? "Meta campaign" : "Email campaign"} code
                      </span>
                      <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-ink">{p.campaignCode}</code>
                      <br />
                      {p.channel === "facebook"
                        ? `Pre-filled WhatsApp text for the ad: “Hi, I'm applying for ${p.title} (${p.campaignCode})”.`
                        : `Ask applicants to reply with “${p.campaignCode}” in the subject, sent to ${ta?.routingEmail ?? "the TA's applications inbox"}.`}
                    </div>
                  )}

                  {(p.aliasKeywords.length > 0 || p.previousTitles.length > 0) && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11.5px] text-ink-faint">Headline also matches:</span>
                      {[...p.previousTitles, ...p.aliasKeywords].map((k) => (
                        <span
                          key={k}
                          className="rounded-md border border-rule px-2 py-[3px] text-[11.5px] text-ink-soft"
                        >
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-7">
                  <div className="text-right">
                    <div className="tabular text-[18px] font-semibold leading-none">{count}</div>
                    <div className="mt-1.5 text-[11px] text-ink-soft">candidates</div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`tabular text-[18px] font-semibold leading-none ${
                        p.cvCountToday < 10 && p.status === "live" ? "text-danger" : ""
                      }`}
                    >
                      {p.cvCountToday}
                    </div>
                    <div className="mt-1.5 text-[11px] text-ink-soft">today</div>
                  </div>
                </div>
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-4 text-[12.5px]">
                <button
                  onClick={() => setEditing(isEditing ? null : p.id)}
                  className="text-ink-soft transition-colors hover:text-ink"
                >
                  {isEditing ? "Close" : "Edit"}
                </button>

                {/* Finding 10 — the type has four states and the control only
                    ever offered two of them, so a finished post could be
                    paused forever but never closed. */}
                {(["draft", "live", "paused", "closed"] as const)
                  .filter((next) => next !== p.status)
                  .map((next) => (
                    <form key={next} action={setPostStatus}>
                      <input type="hidden" name="openingId" value={openingId} />
                      <input type="hidden" name="postId" value={p.id} />
                      <input type="hidden" name="status" value={next} />
                      <SubmitButton
                        tone="dark"
                        pendingLabel="Saving…"
                        className="text-ink-soft transition-colors hover:text-ink disabled:opacity-60"
                      >
                        {next === "live"
                          ? "Set live"
                          : next === "paused"
                            ? "Pause"
                            : next === "draft"
                              ? "Back to draft"
                              : "Close"}
                      </SubmitButton>
                    </form>
                  ))}

                <form action={deleteJobPost} className="ml-auto">
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="postId" value={p.id} />
                  <Confirm
                    label="Delete post"
                    question={
                      count > 0
                        ? `Delete this post? Its ${count} candidate${count === 1 ? "" : "s"} stay on the opening, without a post against them.`
                        : "Delete this post?"
                    }
                    className="text-[12.5px] text-ink-faint transition-colors hover:text-danger"
                  />
                </form>

                {p.status === "paused" && count > 0 && live.length > 0 && (
                  <button
                    onClick={() => setTransferFrom(transferFrom === p.id ? null : p.id)}
                    className="font-medium text-brand transition-colors hover:underline"
                  >
                    Move {count} {count === 1 ? "candidate" : "candidates"} to a live post
                  </button>
                )}
              </div>

              {transferFrom === p.id && (
                <form
                  action={transferCvs}
                  className="mt-3.5 rounded-xl border border-rule bg-paper/60 px-5 py-4"
                >
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="fromPostId" value={p.id} />
                  <p className="text-[12.5px] text-ink-soft">
                    Move to — they keep their stage and their owner.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {live.map((t) => (
                      <SubmitButton
                        key={t.id}
                        name="toPostId"
                        value={t.id}
                        tone="dark"
                        pendingLabel="Moving…"
                        className="rounded-full border border-brand-line px-3.5 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
                      >
                        {t.title}
                      </SubmitButton>
                    ))}
                  </div>
                </form>
              )}

              {isEditing && (
                <form
                  action={updatePost}
                  className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 rounded-xl border border-rule bg-paper/60 px-5 py-4 sm:grid-cols-2"
                >
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="postId" value={p.id} />

                  <label className="sm:col-span-2">
                    <span className="mb-2 block text-[12.5px] font-medium">
                      Title on LinkedIn
                      <span className="ml-2 font-normal text-[11.5px] text-ink-faint">
                        renamed? the old title keeps routing here
                      </span>
                    </span>
                    <input name="title" required defaultValue={p.title} className={inputClass} />
                  </label>

                  <label className="sm:col-span-2">
                    <span className="mb-2 block text-[12.5px] font-medium">
                      LinkedIn link
                      <span className="ml-2 font-normal text-[11.5px] text-ink-faint">
                        the surest match — the job's LinkedIn Recruiter link (talent/hire/…), from the job's page in Recruiter
                      </span>
                    </span>
                    <input
                      name="externalUrl"
                      defaultValue={p.externalUrl ?? ""}
                      placeholder="https://www.linkedin.com/talent/hire/1528413625/overview"
                      className={inputClass}
                    />
                  </label>

                  <div className="sm:col-span-2">
                    <span className="mb-2 block text-[12.5px] font-medium">
                      Alias titles
                      <span className="ml-2 font-normal text-[11.5px] text-ink-faint">
                        old or boosted titles that must keep routing here
                      </span>
                    </span>
                    <TokenInput
                      name="aliasKeywords"
                      initial={p.aliasKeywords}
                      placeholder="GM Marketing"
                    />
                  </div>

                  <label>
                    <span className="mb-2 block text-[12.5px] font-medium">City</span>
                    <input name="city" defaultValue={p.city ?? ""} placeholder="Colombo" className={inputClass} />
                  </label>

                  <label>
                    <span className="mb-2 block text-[12.5px] font-medium">Country</span>
                    <input
                      name="country"
                      defaultValue={p.country ?? ""}
                      placeholder="Sri Lanka"
                      className={inputClass}
                    />
                  </label>

                  <div>
                    <span className="mb-2 block text-[12.5px] font-medium">Recruiter</span>
                    <div className="relative">
                      <select
                        name="assignedTaId"
                        defaultValue={p.assignedTaId ?? ""}
                        className={`${inputClass} cursor-pointer appearance-none pr-10`}
                      >
                        <option value="">Unassigned</option>
                        {users
                          .filter((u) => isTa(u))
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                      </select>
                      <svg width={14} height={14}
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                        className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                      >
                        <path
                          d="M4 6.5L8 10.5L12 6.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  </div>

                  <div className="sm:col-span-2">
                    <SubmitButton
                      pendingLabel="Saving…"
                      className="rounded-full bg-brand px-5 py-2.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
                    >
                      Save post
                    </SubmitButton>
                  </div>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Paste an application email's subject, see which post it would be filed to.
 *
 * The shared mailboxes file by the post rules alone, so a title or alias that
 * does not match sends applicants to the database instead of this opening.
 * This lets the TA check before the CVs come, with the same rules
 * (post routing, 22 September).
 */
function RouteTester({ openingId, bare }: { openingId: string; bare: boolean }) {
  const test = useInline(testPostRouteInline);
  return (
    <form
      onSubmit={(e) => test.run(submitted(e).formData)}
      className={`${bare ? "pb-4" : "border-b border-rule px-7 py-5"} flex flex-col gap-2`}
    >
      <input type="hidden" name="openingId" value={openingId} />
      <span className="text-[12.5px] font-medium">Test a subject</span>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          id={`route-test-${openingId}`}
          name="subject"
          required
          placeholder="New application: Head of Finance from Nimal Perera"
          aria-label="An application email's subject"
          className={`${inputClass} min-w-[260px] flex-1`}
        />
        <SubmitButton
          busy={test.pending}
          locked={test.pending}
          pendingLabel="Checking…"
          tone="dark"
          className="rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
        >
          Check
        </SubmitButton>
      </div>
      <ActionNote result={test.result} />
    </form>
  );
}
