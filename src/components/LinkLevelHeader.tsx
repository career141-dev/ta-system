"use client";

import { useState } from "react";
import { deleteLinkLevel, renameLinkLevel } from "@/app/actions";
import { SubmitButton } from "./Submit";
import { inputClass } from "./form";

/**
 * The L being looked at on Excel Tables, with Rename and Delete for the TA
 * who started it (the desk, 29 Sep). Deleting an L never deletes its rows:
 * they stay in the table under All — the confirm says so.
 */
export function LinkLevelHeader({
  openingId,
  n,
  label,
  name,
  rows,
  own,
  allHref,
}: {
  openingId: string;
  n: number;
  /** "L2 · Banks" or "L2 · 29 Sept". */
  label: string;
  name: string;
  /** How many rows are in it. */
  rows: number;
  /** Started by the person looking — only they rename or delete it. */
  own: boolean;
  allHref: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const small = "rounded-full border border-rule px-2.5 py-0.5 text-[11.5px] text-ink-soft transition-colors hover:border-ink-faint hover:text-ink";

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
      {renaming ? (
        <form action={renameLinkLevel} className="flex items-center gap-2">
          <input type="hidden" name="openingId" value={openingId} />
          <input type="hidden" name="level" value={n} />
          <span className="font-semibold">L{n} ·</span>
          <input
            name="name"
            defaultValue={name}
            maxLength={40}
            autoFocus
            placeholder="A name, e.g. Banks"
            aria-label={`Name for L${n}`}
            className={`${inputClass} h-8 w-52 py-1 text-[12.5px]`}
          />
          <SubmitButton pendingLabel="Saving…" className="rounded-full bg-brand px-3 py-1 text-[12px] font-medium text-white hover:opacity-90">
            Save
          </SubmitButton>
          <button type="button" onClick={() => setRenaming(false)} className="text-[12px] text-ink-soft hover:text-ink">
            Cancel
          </button>
        </form>
      ) : (
        <span className="font-semibold">{label}</span>
      )}
      {own && !renaming && (
        <>
          <button type="button" onClick={() => setRenaming(true)} className={small}>
            Rename
          </button>
          <form
            action={deleteLinkLevel}
            onSubmit={(e) => {
              const what = rows === 1 ? "Its 1 row stays" : `Its ${rows} rows stay`;
              if (!confirm(`Delete L${n}? ${rows ? `${what} in the table, under All.` : "It has no rows."}`)) e.preventDefault();
            }}
          >
            <input type="hidden" name="openingId" value={openingId} />
            <input type="hidden" name="level" value={n} />
            <SubmitButton
              tone="dark"
              pendingLabel="Deleting…"
              className={`${small} hover:border-danger hover:text-danger`}
            >
              Delete
            </SubmitButton>
          </form>
        </>
      )}
      <a href={allHref} className="text-[12px] text-ink-soft hover:text-ink hover:underline">
        Show all Ls
      </a>
    </div>
  );
}
