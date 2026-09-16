"use client";

import { useEffect, useRef, useState } from "react";
import { deleteOpening } from "@/app/actions";

/**
 * The three-dots menu on an opening: Delete this opening.
 *
 * Deleting takes the opening and everything filed under it — posts, the
 * pipeline, calls, messages, reviews, offers — but no candidate. Everyone who
 * was in it stays in the database. The menu asks once, in place, saying how
 * many candidates go back to the database, before anything happens.
 */
export function OpeningMenu({
  openingId,
  title,
  candidates,
}: {
  openingId: string;
  title: string;
  /** People in this opening's pipeline, who go back to the database. */
  candidates: number;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !pending) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && !pending && close();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open, pending]);

  function close() {
    setOpen(false);
    setConfirming(false);
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${title}`}
        className="grid h-7 w-7 place-items-center rounded-full text-ink-faint transition-colors hover:bg-tag hover:text-ink"
      >
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-50 mt-1.5 w-[280px] rounded-xl border border-rule bg-surface py-1 text-left shadow-lg"
        >
          {!confirming ? (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                setConfirming(true);
              }}
              className="flex w-full items-center gap-2 px-3.5 py-2 text-[12.5px] text-danger hover:bg-danger-soft"
            >
              Delete this opening
            </button>
          ) : (
            <form action={deleteOpening} onSubmit={() => setPending(true)} className="px-3.5 py-3">
              <input type="hidden" name="openingId" value={openingId} />
              <p className="text-[12.5px] font-medium leading-snug">Delete &ldquo;{title}&rdquo;?</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">
                The opening and all its data go: posts, the pipeline, calls, messages, reviews and offers.
                {candidates > 0
                  ? ` Its ${candidates} candidate${candidates === 1 ? "" : "s"} ${candidates === 1 ? "is" : "are"} not deleted — they stay in the database.`
                  : " No candidates are deleted."}{" "}
                This cannot be undone.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  disabled={pending}
                  className="rounded-full bg-danger px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {pending ? "Deleting…" : "Delete opening"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={close}
                  className="text-[12px] text-ink-soft hover:text-ink disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
