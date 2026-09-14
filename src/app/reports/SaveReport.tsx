"use client";

import { useState } from "react";
import { saveReport } from "@/app/actions";
import { inputClass } from "@/components/form";

/** Keeps the query, not the figures — so it is right again next month. */
export function SaveReport({ spec, suggested }: { spec: string; suggested: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-full border border-rule px-4 py-2 text-[12.5px] text-ink-soft transition-colors hover:border-rule-strong hover:text-ink"
      >
        Save this report
      </button>
    );
  }

  return (
    <form action={saveReport} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="spec" value={spec} />
      <input
        name="name"
        required
        autoFocus
        defaultValue={suggested}
        placeholder="Name it"
        className={`${inputClass} w-[220px] py-1.5`}
      />
      <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
        <input type="checkbox" name="shared" value="1" />
        Share with the desk
      </label>
      <button className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white">Save</button>
      <button type="button" onClick={() => setOpen(false)} className="px-2 text-[12.5px] text-ink-soft hover:text-ink">
        Cancel
      </button>
    </form>
  );
}
