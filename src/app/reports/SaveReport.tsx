"use client";

import { useState } from "react";
import { saveReportInline } from "@/app/actions";
import { inputClass } from "@/components/form";
import { ActionNote, SubmitButton, submitted, useInline } from "@/components/Submit";

/** Keeps the query, not the figures — so it is right again next month. */
export function SaveReport({ spec, suggested }: { spec: string; suggested: string }) {
  const [open, setOpen] = useState(false);
  // Saving opens the saved report; anything refused says why, here.
  const save = useInline(saveReportInline);

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
    <form onSubmit={(e) => save.run(submitted(e).formData)} className="flex flex-wrap items-center gap-2">
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
      <SubmitButton
        busy={save.pending}
        locked={save.pending}
        pendingLabel="Saving…"
        className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60"
      >
        Save
      </SubmitButton>
      <button type="button" onClick={() => setOpen(false)} className="px-2 text-[12.5px] text-ink-soft hover:text-ink">
        Cancel
      </button>
      <ActionNote result={save.result} className="w-full" />
    </form>
  );
}
