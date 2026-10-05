"use client";

import { externalUrl, profileLink } from "@/lib/url";
import { useEffect, useRef, useState } from "react";
import {
  addLeadNoteInline,
  addLinkToPipelineInline,
  decideCvMatchInline,
  deleteLinkInline,
  logOutreachInline,
  removeLeadNoteInline,
  setLinkInterestInline,
  toggleEyeMarkInline,
  toggleLinkAddOnInline,
  updateLinkInline,
} from "@/app/actions";
import { FindCvButton } from "./FindCvButton";
import { ActionNote, SubmitButton, latest, submitted, useInline } from "./Submit";
import Link from "next/link";
import { inputClass } from "./form";
import { dateAt } from "@/lib/format";
import { newestFirst, noteByline } from "@/lib/leadNotes";
import { STAGE_LABEL } from "@/data/types";
import type { Application, LinkOutcome, LinkVaultEntry } from "@/data/types";
import { INTEREST_LABEL, type Interest } from "@/lib/linkViews";

const OUTCOMES: { value: LinkOutcome; label: string }[] = [
  { value: "no_contact", label: "Not contacted" },
  { value: "contacted", label: "Contacted" },
  { value: "responded", label: "Responded" },
  { value: "cv_received", label: "CV received" },
  { value: "shortlisted", label: "Shortlisted" },
  { value: "declined", label: "Declined" },
  { value: "unreachable", label: "Unreachable" },
];

const PHONE_SOURCES = [
  { value: "", label: "—" },
  { value: "mutual_connection", label: "Mutual connection" },
  { value: "reception_call", label: "Reception / switchboard" },
  { value: "internal_db", label: "Someone in our database" },
  { value: "profile", label: "On their profile" },
  { value: "other", label: "Other" },
];

const chev = (
  <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
    <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * One row of Excel Tables — spec §4.5, to the Figma frame.
 *
 * Label on the left, facts on the right, the same as every other candidate row
 * in the product. `Overview` carries where they are and what has been said to
 * them; `LinkedIn URL` carries the link the whole record hangs off.
 *
 * `Notes` sits above both when a lead, director, admin or ops has left one:
 * feedback for the TA, open on the row rather than behind •••, so it is read
 * without being looked for (25 Sep).
 */
export function LinkRow({
  entry: r,
  openingId,
  addedByName,
  userNames,
  onPipeline = null,
  interest = "pending",
  canNote = false,
  viewerId = "",
}: {
  entry: LinkVaultEntry;
  openingId: string;
  addedByName: string;
  userNames: Record<string, string>;
  /** Their application on this opening, once they have been added. */
  onPipeline?: Pick<Application, "id" | "stage"> | null;
  /** Pending, Interested or Not interested (lib/linkViews interestOf). */
  interest?: Interest;
  /** A lead, director, admin or ops: may leave notes for the TA. */
  canNote?: boolean;
  /** Who is looking — the author of a note may remove it. */
  viewerId?: string;
}) {
  const [removed, setRemoved] = useState(false);
  const [isEyeMarked, setIsEyeMarked] = useState(r.isEyeMarked);
  const [edit, setEdit] = useState(false);
  // Opened from "Add to pipeline" on a row that is not shortlisted yet.
  const [forPipeline, setForPipeline] = useState(false);
  const [allLog, setAllLog] = useState(false);
  const [askWhy, setAskWhy] = useState(false);
  // Every button on the row answers under the row (21 Sep: they answered at
  // the top of the page, or not at all).
  const eye = useInline(toggleEyeMarkInline);
  const addOn = useInline(toggleLinkAddOnInline);
  const save = useInline(updateLinkInline);
  const toPipeline = useInline(addLinkToPipelineInline);
  const setInterest = useInline(setLinkInterestInline);
  const decide = useInline(decideCvMatchInline);
  const logIt = useInline(logOutreachInline);
  // Cleared once the approach is logged, not on the click: a refused note
  // stays to be sent again (review of PR #2, 21 Sep).
  const logForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (logIt.result?.tone === "ok") logForm.current?.reset();
  }, [logIt.result]);
  const del = useInline(deleteLinkInline);
  const [noteOpen, setNoteOpen] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  const sendNote = useInline(addLeadNoteInline);
  const dropNote = useInline(removeLeadNoteInline);
  // Closed once the note is sent; a refused one stays in the box to send again.
  const noteForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (sendNote.result?.tone === "ok") {
      noteForm.current?.reset();
      setNoteOpen(false);
    }
  }, [sendNote.result]);
  const busy =
    eye.pending || addOn.pending || save.pending || toPipeline.pending || setInterest.pending || logIt.pending || del.pending || sendNote.pending || dropNote.pending;
  const answer = latest(eye.result, addOn.result, save.result, toPipeline.result, setInterest.result, logIt.result, del.result, sendNote.result, dropNote.result);

  useEffect(() => {
    setIsEyeMarked(r.isEyeMarked);
  }, [r.isEyeMarked]);

  useEffect(() => {
    if (del.result && del.result.tone !== "ok") {
      setRemoved(false);
    }
  }, [del.result]);

  // The name the row can go to the pipeline under: typed, or read from the link.
  const guessedName = profileLink(r.linkedinUrl)?.guessedName ?? "";
  const selectClass = `${inputClass} cursor-pointer appearance-none pr-9`;
  const log = [...r.conversationLog].reverse();
  // The latest reason given for Not interested, shown under the badge.
  const why = log.find((c) => c.channel === "Not interested");
  const shown = allLog ? log : log.slice(0, 2);
  const outcome = OUTCOMES.find((o) => o.value === r.outcome)?.label ?? r.outcome;
  const notes = newestFirst(r.leadNotes);
  const shownNotes = allNotes ? notes : notes.slice(0, 2);

  if (removed || del.result?.tone === "ok") return null;

  return (
    <article className="px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex gap-3.5">
        <form
          onSubmit={(e) => {
            setIsEyeMarked((prev) => !prev);
            eye.run(submitted(e).formData);
          }}
          className="pt-1"
        >
          <input type="hidden" name="openingId" value={openingId} />
          <input type="hidden" name="entryId" value={r.id} />
          <button
            disabled={busy}
            aria-busy={eye.pending}
            title={isEyeMarked ? "Eye-marked — a high-conviction profile" : "Eye-mark this profile"}
            className={`grid h-[15px] w-[15px] place-items-center rounded-[3px] border text-[10px] leading-none transition-colors ${
              isEyeMarked ? "border-brand bg-brand text-white" : "border-rule-strong text-transparent hover:border-brand"
            }`}
          >
            ✓
          </button>
        </form>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-[200px]">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={externalUrl(r.linkedinUrl) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[14px] font-semibold text-accent hover:underline"
                >
                  {r.name ?? profileLink(r.linkedinUrl)?.guessedName ?? "Unnamed profile"}
                </a>
                {!r.name && profileLink(r.linkedinUrl)?.guessedName && (
                  <span className="text-[11px] italic text-ink-faint">name read from the link</span>
                )}
                <span className="text-[11px] text-ink-faint">in · 2nd</span>
                <span className="rounded bg-tag px-1.5 py-[3px] text-[10.5px] font-medium text-ink-soft">
                  {outcome}
                </span>
                {r.level ? (
                  <span className="rounded bg-tag px-1.5 py-[3px] text-[10.5px] font-medium tabular-nums text-ink-soft" title="The L it was added under">
                    L{r.level}
                  </span>
                ) : null}
                <span
                  className={`rounded px-1.5 py-[3px] text-[10.5px] font-medium ${
                    interest === "interested" ? "bg-brand-soft text-brand" : interest === "not_interested" ? "bg-danger-soft text-danger" : "bg-warn-soft text-ink-soft"
                  }`}
                >
                  {INTEREST_LABEL[interest]}
                </span>
                {r.isAddOn && (
                  <span className="rounded bg-brand-soft px-1.5 py-[3px] text-[10.5px] font-medium text-brand">Add-on</span>
                )}
                {notes.length > 0 && (
                  <span className="rounded bg-brand-soft px-1.5 py-[3px] text-[10.5px] font-medium text-brand">
                    Note from {noteByline(notes[0], userNames).role}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[13px]">{r.title ?? "Title not recorded"}</p>
              <p className="mt-0.5 text-[12px] text-ink-faint">
                {[r.company, r.phoneNumber].filter(Boolean).join(" · ") || "No company or number yet"}
              </p>
              <CvStatus entry={r} openingId={openingId} decide={decide} />
              {interest === "not_interested" && why && (
                <p className="mt-1 text-[12px] text-danger">Not interested — {why.note}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {/* Not interested asks why first (the desk, 29 Sep); the reason
                    goes on the Rejected entry and on this row's log. */}
                {interest !== "not_interested" &&
                  (askWhy ? (
                    <form
                      onSubmit={(e) => {
                        setInterest.run(submitted(e).formData);
                        setAskWhy(false);
                      }}
                      className="flex flex-wrap items-center gap-1.5"
                    >
                      <input type="hidden" name="openingId" value={openingId} />
                      <input type="hidden" name="entryId" value={r.id} />
                      <input type="hidden" name="interest" value="not_interested" />
                      <input
                        name="reason"
                        required
                        autoFocus
                        maxLength={300}
                        placeholder="Why not interested? e.g. happy where they are"
                        className="w-full sm:w-[260px] rounded-full border border-rule-strong bg-surface px-3 py-1 text-[12px]"
                      />
                      <SubmitButton
                        busy={setInterest.pending}
                        locked={busy}
                        pendingLabel="Updating…"
                        tone="dark"
                        className="rounded-full border border-danger px-2.5 py-0.5 text-[11.5px] text-danger disabled:opacity-60"
                      >
                        Save
                      </SubmitButton>
                      <button type="button" onClick={() => setAskWhy(false)} className="px-1 text-[11.5px] text-ink-soft hover:text-ink">
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAskWhy(true)}
                      className="rounded-full border border-rule-strong px-2.5 py-0.5 text-[11.5px] text-ink-soft transition-colors hover:border-danger hover:text-danger disabled:opacity-60"
                    >
                      Not interested
                    </button>
                  ))}
                {(["interested"] as const)
                  .filter((to) => to !== interest)
                  .map((to) => (
                    <form key={to} onSubmit={(e) => setInterest.run(submitted(e).formData)}>
                      <input type="hidden" name="openingId" value={openingId} />
                      <input type="hidden" name="entryId" value={r.id} />
                      <input type="hidden" name="interest" value={to} />
                      <SubmitButton
                        busy={setInterest.pending}
                        locked={busy}
                        pendingLabel="Updating…"
                        tone="dark"
                        className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors disabled:opacity-60 ${
                          to === "interested"
                            ? "border-brand-line text-brand hover:bg-brand-soft"
                            : "border-rule-strong text-ink-soft hover:border-danger hover:text-danger"
                        }`}
                      >
                        {to === "interested" ? "Interested" : "Not interested"}
                      </SubmitButton>
                    </form>
                  ))}
              </div>
            </div>

            <div className="flex w-full shrink-0 flex-col items-start gap-2 sm:w-auto sm:items-end">
              <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                {onPipeline ? (
                  <Link
                    href={`/openings/${openingId}/candidate/${onPipeline.id}`}
                    className="rounded-full border border-brand-line bg-brand-soft px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:opacity-90"
                  >
                    In {STAGE_LABEL[onPipeline.stage]} →
                  </Link>
                ) : r.outcome === "shortlisted" && r.name ? (
                  <form onSubmit={(e) => toPipeline.run(submitted(e).formData)}>
                    <input type="hidden" name="openingId" value={openingId} />
                    <input type="hidden" name="entryId" value={r.id} />
                    <SubmitButton
                      busy={toPipeline.pending}
                      locked={busy}
                      pendingLabel="Adding…"
                      tone="dark"
                      className="rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
                    >
                      Add to pipeline
                    </SubmitButton>
                  </form>
                ) : (
                  // Not greyed out: it opens the panel with Shortlisted picked and
                  // the name filled in, one Save away (21 Sep).
                  <button
                    type="button"
                    onClick={() => {
                      setForPipeline(true);
                      setEdit(true);
                    }}
                    className="rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
                  >
                    Add to pipeline
                  </button>
                )}
                {canNote && (
                  <button
                    type="button"
                    onClick={() => setNoteOpen((v) => !v)}
                    aria-expanded={noteOpen}
                    className="rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
                  >
                    Add note
                  </button>
                )}
                <form onSubmit={(e) => addOn.run(submitted(e).formData)}>
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="entryId" value={r.id} />
                  <input type="hidden" name="on" value={r.isAddOn ? "0" : "1"} />
                  <SubmitButton
                    busy={addOn.pending}
                    locked={busy}
                    pendingLabel="Saving…"
                    tone="dark"
                    className={`whitespace-nowrap rounded-full border px-4 py-1.5 text-[12.5px] transition-colors disabled:opacity-60 ${
                      r.isAddOn
                        ? "border-brand bg-brand-soft font-medium text-brand"
                        : "border-rule-strong text-ink-soft hover:border-ink-faint hover:text-ink"
                    }`}
                  >
                    {r.isAddOn ? "Add-on ✓" : "Add-on"}
                  </SubmitButton>
                </form>
                <button
                  onClick={() => setEdit((v) => !v)}
                  className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  Change outcome ⇕
                </button>
                <a
                  href={externalUrl(r.linkedinUrl) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-rule px-4 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
                >
                  Open profile
                </a>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!window.confirm("Are you sure you want to remove this link from the table?")) return;
                    const { formData } = submitted(e);
                    del.run(formData);
                  }}
                >
                  <input type="hidden" name="openingId" value={openingId} />
                  <input type="hidden" name="entryId" value={r.id} />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-full border border-rule px-3.5 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-danger hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                  >
                    {del.pending ? "Removing…" : "Remove"}
                  </button>
                </form>
                <button
                  onClick={() => setEdit((v) => !v)}
                  aria-label="More"
                  className="rounded px-1.5 text-[15px] leading-none text-ink-faint transition-colors hover:text-ink"
                >
                  •••
                </button>
              </div>
              <p className="text-right text-[11px] leading-snug text-ink-faint">
                Added {dateAt(r.createdAt)}
                <br />
                by {addedByName}
              </p>
            </div>
          </div>

          {canNote && noteOpen && (
            <form
              ref={noteForm}
              onSubmit={(e) => sendNote.run(submitted(e).formData)}
              className="mt-3 flex flex-col gap-2.5"
            >
              <input type="hidden" name="openingId" value={openingId} />
              <input type="hidden" name="entryId" value={r.id} />
              <span className="text-[11.5px] text-ink-soft">Note for the TA</span>
              <textarea
                name="note"
                rows={3}
                maxLength={2000}
                autoFocus
                placeholder="What the TA should know or do with this person"
                className={`${inputClass} leading-relaxed`}
              />
              <div className="flex items-center gap-2.5">
                <SubmitButton
                  busy={sendNote.pending}
                  locked={busy}
                  pendingLabel="Sending…"
                  className="rounded-full bg-brand px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  Send note
                </SubmitButton>
                <button
                  type="button"
                  onClick={() => setNoteOpen(false)}
                  className="text-[12px] text-ink-faint transition-colors hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <dl className="mt-3 grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 break-words text-[12.5px] leading-relaxed sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-x-4">
            {notes.length > 0 && (
              <>
                <dt className="font-medium text-ink-soft">Notes</dt>
                <dd className="flex flex-col gap-1.5">
                  {shownNotes.map((n) => {
                    const { role, name } = noteByline(n, userNames);
                    return (
                      <div key={n.id} className="rounded-lg border border-brand-line bg-brand-soft px-3 py-2">
                        <p className="whitespace-pre-line text-ink">{n.note}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-soft">
                          <span className="font-semibold text-brand">{role}</span>
                          <span>· {name} sent this note · {dateAt(n.at)}</span>
                          {n.by === viewerId && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (!window.confirm("Remove this note? The TA will no longer see it.")) return;
                                dropNote.run(submitted(e).formData);
                              }}
                              className="inline"
                            >
                              <input type="hidden" name="openingId" value={openingId} />
                              <input type="hidden" name="entryId" value={r.id} />
                              <input type="hidden" name="noteId" value={n.id} />
                              <button
                                type="submit"
                                disabled={busy}
                                className="text-ink-faint transition-colors hover:text-danger disabled:opacity-50"
                              >
                                · Remove
                              </button>
                            </form>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {notes.length > 2 && (
                    <button
                      onClick={() => setAllNotes((v) => !v)}
                      className="self-start text-[12px] text-accent hover:underline"
                    >
                      {allNotes ? "Show less" : `Show all (${notes.length})`}
                    </button>
                  )}
                </dd>
              </>
            )}
            <dt className="font-medium text-ink-soft">Overview</dt>
            <dd>
              <span className="text-ink-soft">
                {r.title ?? "Role unknown"}{r.company ? ` at ${r.company}` : ""} · {outcome.toLowerCase()}
              </span>
              {shown.map((c, i) => (
                <span key={i} className="mt-0.5 block">
                  {c.note}{" "}
                  <span className="italic text-ink-faint">
                    {c.channel} · {userNames[c.by] ?? c.by} · {dateAt(c.at)}
                  </span>
                </span>
              ))}
              {log.length > 2 && (
                <button
                  onClick={() => setAllLog((v) => !v)}
                  className="mt-0.5 block text-[12px] text-accent hover:underline"
                >
                  {allLog ? "Show less" : `Show all (${log.length})`}
                </button>
              )}
            </dd>

            <dt className="font-medium text-ink-soft">LinkedIn URL</dt>
            <dd className="truncate">
              <a href={externalUrl(r.linkedinUrl) ?? undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {r.linkedinUrl.replace(/^https?:\/\//, "")}
              </a>
              {r.phoneSource && (
                <span className="block text-ink-faint">
                  Number via {PHONE_SOURCES.find((p) => p.value === r.phoneSource)?.label?.toLowerCase()}
                </span>
              )}
            </dd>
          </dl>

          {!edit && <ActionNote result={answer} className="mt-3" />}

          {edit && (
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-6 border-t border-rule pt-4 lg:grid-cols-2">
              <form
                onSubmit={(e) => {
                  const { formData, pressed } = submitted(e);
                  (pressed === "pipeline" ? toPipeline : save).run(formData);
                }}
                className="flex flex-col gap-3.5"
              >
                {forPipeline && !onPipeline && (
                  <p className="rounded-lg bg-brand-soft px-3 py-2 text-[12px] text-brand">
                    To go to the pipeline they need a name and the Shortlisted outcome — both are filled in below. Check
                    them and press Save and add to pipeline.
                  </p>
                )}
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="entryId" value={r.id} />
                <div className="grid grid-cols-2 gap-3">
                  <label>
                    <span className="mb-1.5 block text-[11.5px] text-ink-soft">Name</span>
                    {/* The name read from the link is a suggestion, not a value: pre-filled,
                        a plain Save stored the guess as if typed (review of PR #2). */}
                    <input name="name" defaultValue={r.name ?? ""} placeholder={guessedName || undefined} className={inputClass} />
                  </label>
                  <label>
                    <span className="mb-1.5 block text-[11.5px] text-ink-soft">Company</span>
                    <input name="company" defaultValue={r.company ?? ""} className={inputClass} />
                  </label>
                </div>
                <label>
                  <span className="mb-1.5 block text-[11.5px] text-ink-soft">Outcome</span>
                  <div className="relative">
                    <select name="outcome" defaultValue={forPipeline ? "shortlisted" : r.outcome} className={selectClass}>
                      {OUTCOMES.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    {chev}
                  </div>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label>
                    <span className="mb-1.5 block text-[11.5px] text-ink-soft">Phone</span>
                    <input name="phoneNumber" defaultValue={r.phoneNumber ?? ""} placeholder="+94 7…" className={inputClass} />
                  </label>
                  <label>
                    <span className="mb-1.5 block text-[11.5px] text-ink-soft">How you got it</span>
                    <div className="relative">
                      <select name="phoneSource" defaultValue={r.phoneSource ?? ""} className={selectClass}>
                        {PHONE_SOURCES.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {chev}
                    </div>
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <SubmitButton
                    name="intent"
                    value="save"
                    busy={save.pending}
                    locked={busy}
                    pendingLabel="Saving…"
                    className="rounded-full bg-brand px-4 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    Save
                  </SubmitButton>
                  {!onPipeline && (
                    <SubmitButton
                      name="intent"
                      value="pipeline"
                      busy={toPipeline.pending}
                      locked={busy}
                      pendingLabel="Adding…"
                      tone="dark"
                      className="rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
                    >
                      Save and add to pipeline
                    </SubmitButton>
                  )}
                </div>
                <ActionNote result={latest(save.result, toPipeline.result)} />
              </form>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!window.confirm("Are you sure you want to remove this link from the table?")) return;
                  setRemoved(true);
                  const { formData } = submitted(e);
                  del.run(formData);
                }}
                className="lg:col-span-2"
              >
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="entryId" value={r.id} />
                <button
                  type="submit"
                  disabled={busy}
                  className="text-[12px] text-ink-faint transition-colors hover:text-danger disabled:opacity-50"
                >
                  {del.pending ? "Removing…" : "Remove this link from table"}
                </button>
              </form>

              <form
                ref={logForm}
                onSubmit={(e) => logIt.run(submitted(e).formData)}
                className="flex flex-col gap-2.5"
              >
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="entryId" value={r.id} />
                <span className="text-[11.5px] text-ink-soft">Log an approach</span>
                <textarea name="note" rows={3} placeholder="What happened on this approach" className={`${inputClass} leading-relaxed`} />
                <div className="flex items-center gap-2.5">
                  <div className="relative">
                    <select name="channel" defaultValue="linkedin" className={`${selectClass} py-1.5 text-[12px]`}>
                      <option value="linkedin">LinkedIn</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="call">Call</option>
                      <option value="email">Email</option>
                    </select>
                    {chev}
                  </div>
                  <SubmitButton
                    busy={logIt.pending}
                    locked={busy}
                    pendingLabel="Logging…"
                    tone="dark"
                    className="rounded-full border border-brand-line px-3.5 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
                  >
                    Log it
                  </SubmitButton>
                </div>
                <ActionNote result={latest(logIt.result, del.result, eye.result)} />
              </form>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * Whether we already hold this person, and their CV (28 Sep, lib/cvMatch).
 * A certain match is linked already; a possible one asks the TA, because
 * guessing either way is wrong — a second record, or someone else's CV.
 */
function CvStatus({
  entry: r,
  openingId,
  decide,
}: {
  entry: LinkVaultEntry;
  openingId: string;
  decide: ReturnType<typeof useInline>;
}) {
  const m = r.cvMatch ?? null;
  const pill = "mt-1.5 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2.5 py-1.5 text-[12px]";
  const linkCls = "font-medium text-accent hover:underline";

  if (r.candidateId) {
    const hasCv = m ? m.hasCv : null;
    return (
      <div className={`${pill} bg-brand-soft text-brand`}>
        {/* Said as a match, so the TA can see it may be wrong (1 Oct): from a
            LinkedIn profile there is often only a name and a company to go on. */}
        <span>
          {m ? <>Matched to <strong>{m.fullName}</strong> in our database</> : "In our database"}
          {hasCv === false ? " — no CV yet" : ""}
        </span>
        {hasCv !== false && (
          <a href={`/api/cv/${encodeURIComponent(r.candidateId)}`} target="_blank" rel="noreferrer" className={linkCls}>
            View CV
          </a>
        )}
        <Link href={`/candidates/${encodeURIComponent(r.candidateId)}`} className={linkCls}>
          Their record
        </Link>
        {m?.reasons.length ? <span className="text-ink-faint">· {m.reasons.join(", ")}</span> : null}
        {/* Linked by the matching on its own: a TA can say it is someone else
            (1 Oct — profiles were landing on the wrong person). */}
        {m && m.candidateId === r.candidateId && m.decided !== "same" && (
          <form onSubmit={(e) => decide.run(submitted(e).formData)} className="inline">
            <input type="hidden" name="openingId" value={openingId} />
            <input type="hidden" name="entryId" value={r.id} />
            <button
              name="decision"
              value="different"
              disabled={decide.pending}
              title="This LinkedIn profile is someone else. The row is unlinked from this candidate, and their CV and details stay out of it."
              className="rounded-full border border-rule-strong bg-surface px-2.5 py-0.5 text-[11.5px] font-medium text-ink hover:border-danger hover:text-danger disabled:opacity-60"
            >
              Not the same person
            </button>
          </form>
        )}
        <ActionNote result={decide.result} className="w-full" />
      </div>
    );
  }
  if (m?.strength === "possible" && !m.decided) {
    return (
      <form
        onSubmit={(e) => decide.run(submitted(e).formData)}
        className={`${pill} border border-warn/40 bg-warn-soft text-warn`}
      >
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="entryId" value={r.id} />
        <span>
          Possibly <strong>{m.fullName}</strong>, already in our database{m.hasCv ? " with a CV" : ""} ({m.reasons.join(", ")}).
        </span>
        <Link href={`/candidates/${encodeURIComponent(m.candidateId)}`} target="_blank" className={linkCls}>
          Check
        </Link>
        <button name="decision" value="same" disabled={decide.pending} className="rounded-full bg-brand px-3 py-0.5 text-[11.5px] font-medium text-white disabled:opacity-60">
          Same person
        </button>
        <button name="decision" value="different" disabled={decide.pending} className="rounded-full border border-rule-strong bg-surface px-3 py-0.5 text-[11.5px] font-medium text-ink disabled:opacity-60">
          Different person
        </button>
        <ActionNote result={decide.result} className="w-full" />
      </form>
    );
  }
  return (
    <>
      <p className="mt-1.5 text-[12px] text-ink-faint">Not matched to anyone in our database yet</p>
      {/* The matching only links when certain; Find CV asks on demand (1 Oct). */}
      <FindCvButton openingId={openingId} entryId={r.id} />
    </>
  );
}
