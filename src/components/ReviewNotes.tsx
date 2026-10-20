"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { addReviewNoteInline, removeReviewNoteInline } from "@/app/actions";
import { inputClass } from "./form";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";
import { noteByline, newestFirst } from "@/lib/leadNotes";
import { timeAt } from "@/lib/format";
import type { LeadNote } from "@/data/types";

/**
 * Notes on a person in Director review. The TA, the lead, the director and an
 * admin can all add one (29 Sep); each line says whose it is, and only its
 * writer can take it back.
 */
export function ReviewNotes({
  appId,
  openingId,
  notes,
  userNames,
  meId,
  canAdd,
}: {
  appId: string;
  openingId: string;
  notes: LeadNote[];
  userNames: Record<string, string>;
  meId: string;
  canAdd: boolean;
}) {
  const router = useRouter();
  const add = useInline(addReviewNoteInline);
  const drop = useInline(removeReviewNoteInline);
  const form = useRef<HTMLFormElement>(null);

  const [noteText, setNoteText] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const draftCheckedRef = useRef(false);

  useEffect(() => {
    if (draftCheckedRef.current) return;
    draftCheckedRef.current = true;
    try {
      const raw = localStorage.getItem(`review-note-draft:${appId}`);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (draft && typeof draft.note === "string" && draft.note.trim().length > 0) {
        setNoteText(draft.note);
        setDraftRestored(true);
      }
    } catch {}
  }, [appId]);

  useEffect(() => {
    if (!draftCheckedRef.current) return;
    const timer = setTimeout(() => {
      try {
        if (noteText.trim().length > 0) {
          localStorage.setItem(`review-note-draft:${appId}`, JSON.stringify({ note: noteText, updatedAt: Date.now() }));
        } else {
          localStorage.removeItem(`review-note-draft:${appId}`);
          setDraftRestored(false);
        }
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [noteText, appId]);

  const discardDraft = () => {
    try {
      localStorage.removeItem(`review-note-draft:${appId}`);
    } catch {}
    setNoteText("");
    setDraftRestored(false);
  };

  useEffect(() => {
    if (add.result?.tone === "ok") {
      try {
        localStorage.removeItem(`review-note-draft:${appId}`);
      } catch {}
      setNoteText("");
      setDraftRestored(false);
      form.current?.reset();
    }
    if (add.result?.ok || drop.result?.ok) router.refresh();
  }, [add.result, drop.result, router, appId]);

  const shown = newestFirst(notes);

  return (
    <section className="mt-3 rounded-xl border border-rule bg-surface px-5 py-4 text-[12.5px]">
      <h2 className="text-[13px] font-semibold">Director review notes</h2>

      {shown.length === 0 ? (
        <p className="mt-2 text-ink-faint">No notes yet.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {shown.map((n) => {
            const by = noteByline(n, userNames);
            return (
              <li key={n.id} className="rounded-lg border border-rule bg-paper px-3.5 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-faint">
                  <span>
                    <span className="font-medium text-ink-soft">{by.role}</span> · {by.name} · {timeAt(n.at)}
                  </span>
                  {n.by === meId && (
                    <form onSubmit={(e) => drop.run(submitted(e).formData)}>
                      <input type="hidden" name="appId" value={appId} />
                      <input type="hidden" name="openingId" value={openingId} />
                      <input type="hidden" name="noteId" value={n.id} />
                      <button disabled={drop.pending} className="text-ink-faint hover:text-red-600 disabled:opacity-60">
                        Remove
                      </button>
                    </form>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px]">{n.note}</p>
              </li>
            );
          })}
        </ul>
      )}

      {canAdd && (
        <form ref={form} onSubmit={(e) => add.run(submitted(e).formData)} className="mt-3">
          <input type="hidden" name="appId" value={appId} />
          <input type="hidden" name="openingId" value={openingId} />
          {draftRestored && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-800 dark:text-amber-200">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span>Draft note restored</span>
              </div>
              <button
                type="button"
                onClick={discardDraft}
                className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
              >
                Discard
              </button>
            </div>
          )}
          <textarea
            name="note"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Add a note for the Director review…"
            className={inputClass}
          />
          <div className="mt-2 flex justify-end">
            <SubmitButton
              busy={add.pending}
              locked={add.pending}
              pendingLabel="Adding…"
              className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              Add note
            </SubmitButton>
          </div>
        </form>
      )}

      <ActionNote result={add.result} className="mt-3" />
      <ActionNote result={drop.result} className="mt-3" />
    </section>
  );
}
