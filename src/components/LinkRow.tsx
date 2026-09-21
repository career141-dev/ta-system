"use client";

import { externalUrl, profileLink } from "@/lib/url";
import { useEffect, useRef, useState } from "react";
import {
  addLinkToPipelineInline,
  deleteLinkInline,
  logOutreachInline,
  toggleEyeMarkInline,
  updateLinkInline,
} from "@/app/actions";
import { ActionNote, SubmitButton, latest, submitted, useInline } from "./Submit";
import Link from "next/link";
import { inputClass } from "./form";
import { Confirm } from "./Confirm";
import { dateAt } from "@/lib/format";
import { STAGE_LABEL } from "@/data/types";
import type { Application, LinkOutcome, LinkVaultEntry } from "@/data/types";

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
 */
export function LinkRow({
  entry: r,
  openingId,
  addedByName,
  userNames,
  onPipeline = null,
}: {
  entry: LinkVaultEntry;
  openingId: string;
  addedByName: string;
  userNames: Record<string, string>;
  /** Their application on this opening, once they have been added. */
  onPipeline?: Pick<Application, "id" | "stage"> | null;
}) {
  const [edit, setEdit] = useState(false);
  // Opened from "Add to pipeline" on a row that is not shortlisted yet.
  const [forPipeline, setForPipeline] = useState(false);
  const [allLog, setAllLog] = useState(false);
  // Every button on the row answers under the row (21 Sep: they answered at
  // the top of the page, or not at all).
  const eye = useInline(toggleEyeMarkInline);
  const save = useInline(updateLinkInline);
  const toPipeline = useInline(addLinkToPipelineInline);
  const logIt = useInline(logOutreachInline);
  // Cleared once the approach is logged, not on the click: a refused note
  // stays to be sent again (review of PR #2, 21 Sep).
  const logForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (logIt.result?.tone === "ok") logForm.current?.reset();
  }, [logIt.result]);
  const del = useInline(deleteLinkInline);
  const busy = eye.pending || save.pending || toPipeline.pending || logIt.pending || del.pending;
  const answer = latest(eye.result, save.result, toPipeline.result, logIt.result, del.result);
  // The name the row can go to the pipeline under: typed, or read from the link.
  const guessedName = profileLink(r.linkedinUrl)?.guessedName ?? "";
  const selectClass = `${inputClass} cursor-pointer appearance-none pr-9`;
  const log = [...r.conversationLog].reverse();
  const shown = allLog ? log : log.slice(0, 2);
  const outcome = OUTCOMES.find((o) => o.value === r.outcome)?.label ?? r.outcome;

  return (
    <article className="px-6 py-5">
      <div className="flex gap-3.5">
        <form onSubmit={(e) => eye.run(submitted(e).formData)} className="pt-1">
          <input type="hidden" name="openingId" value={openingId} />
          <input type="hidden" name="entryId" value={r.id} />
          <button
            disabled={busy}
            aria-busy={eye.pending}
            title={r.isEyeMarked ? "Eye-marked — a high-conviction profile" : "Eye-mark this profile"}
            className={`grid h-[15px] w-[15px] place-items-center rounded-[3px] border text-[10px] leading-none transition-colors ${
              r.isEyeMarked ? "border-brand bg-brand text-white" : "border-rule-strong text-transparent hover:border-brand"
            }`}
          >
            ✓
          </button>
        </form>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
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
              </div>
              <p className="mt-0.5 text-[13px]">{r.title ?? "Title not recorded"}</p>
              <p className="mt-0.5 text-[12px] text-ink-faint">
                {[r.company, r.phoneNumber].filter(Boolean).join(" · ") || "No company or number yet"}
              </p>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-2">
              <div className="flex items-center gap-2">
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

          <dl className="mt-3 grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 text-[12.5px] leading-relaxed">
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
            <div className="mt-4 grid gap-6 border-t border-rule pt-4 lg:grid-cols-2">
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

              {/* Finding 02 — a row pasted by mistake, or a person who turns out
                  to be the wrong one, had to stay in the table forever. */}
              <form onSubmit={(e) => del.run(submitted(e).formData)} className="lg:col-span-2">
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="entryId" value={r.id} />
                <Confirm
                  label="Delete this row"
                  question={
                    log.length > 0
                      ? `Delete ${r.name ?? "this row"} and the ${log.length} approach${log.length === 1 ? "" : "es"} logged against them?`
                      : `Delete ${r.name ?? "this row"} from the table?`
                  }
                  className="text-[12px] text-ink-faint transition-colors hover:text-danger"
                />
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
