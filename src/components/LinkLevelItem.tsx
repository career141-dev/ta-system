"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { deleteLinkLevel, renameLinkLevelInline } from "@/app/actions";
import { SubmitButton, submitted, useInline } from "./Submit";

/**
 * One of the TA's L's under Excel Tables in the sidebar, with its own ⋯ for
 * Rename and Delete — where the L is, not on another page (the desk, 29 Sep).
 * Rename edits the name in place. Delete never deletes rows: they stay in the
 * table under All, and the confirm says so.
 */
export function LinkLevelItem({
  openingId,
  href,
  level,
  active,
  className,
  workLocationId,
}: {
  openingId: string;
  href: string;
  level: { n: number; label: string; name: string; count: number; canManage?: boolean };
  active: boolean;
  /** The sidebar's sub-row look. */
  className: string;
  workLocationId?: string;
}) {
  const canManage = level.canManage !== false;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The box stays open until the name is saved, then closes; a refusal stays
  // on screen under it.
  const save = useInline(renameLinkLevelInline);
  useEffect(() => {
    if (save.result?.ok) setRenaming(false);
  }, [save.result]);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  if (renaming) {
    return (
      <form className="flex flex-wrap items-center gap-1 py-1" onSubmit={(e) => save.run(submitted(e).formData)}>
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="level" value={level.n} />
        <input type="hidden" name="workLocationId" value={workLocationId ?? ""} />
        <span className="text-[12px] font-semibold">L{level.n}</span>
        <input
          name="name"
          defaultValue={level.name}
          maxLength={40}
          autoFocus
          placeholder="Name, e.g. Banks"
          aria-label={`Name for L${level.n}`}
          onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
          className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-2 py-1 text-[12px] outline-none focus:border-brand"
        />
        <SubmitButton busy={save.pending} pendingLabel="…" className="rounded-md bg-brand px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90">
          Save
        </SubmitButton>
        {save.result && !save.result.ok && <p className="w-full text-[11.5px] text-danger">{save.result.message}</p>}
      </form>
    );
  }

  return (
    <div ref={box} className="group relative flex items-center">
      <Link href={href} className={`${className} min-w-0 flex-1 justify-between`}>
        <span className="truncate">{level.label}</span>
        <span className="tabular-nums text-ink-faint">{level.count}</span>
      </Link>
      {canManage && (
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          aria-label={`More for L${level.n}`}
          aria-expanded={menu}
          title="Rename or delete"
          className={`ml-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[14px] leading-none text-ink-faint transition-colors hover:bg-rule/40 hover:text-ink ${
            active || menu ? "" : "opacity-60 group-hover:opacity-100"
          }`}
        >
          ⋯
        </button>
      )}
      {menu && (
        <div className="absolute right-0 top-7 z-20 w-32 overflow-hidden rounded-lg border border-rule bg-surface py-1 text-[12.5px] shadow-lg">
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
            className="block w-full px-3 py-1.5 text-left hover:bg-tag"
          >
            Rename
          </button>
          <form
            action={deleteLinkLevel}
            onSubmit={(e) => {
              const rows = level.count === 1 ? "Its 1 row stays" : `Its ${level.count} rows stay`;
              // Left open until the page reloads: closing it here would take
              // the form away before it is sent.
              if (!confirm(`Delete L${level.n}? ${level.count ? `${rows} in the table, under All.` : "It has no rows."}`)) e.preventDefault();
            }}
          >
            <input type="hidden" name="openingId" value={openingId} />
            <input type="hidden" name="level" value={level.n} />
            <input type="hidden" name="workLocationId" value={workLocationId ?? ""} />
            <button type="submit" className="block w-full px-3 py-1.5 text-left text-danger hover:bg-danger-soft">
              Delete
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
