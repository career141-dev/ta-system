"use client";

import { addLinkInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";

/**
 * Excel Tables' add box.
 *
 * A plain text box, not `type="url"`: the browser refused anything without
 * `https://` before the form was sent, which is how most people copy a
 * profile (testing, 21 Sep). The server tidies the address; a name typed here
 * is used, otherwise one is read from the link. The answer — added, already
 * there, not a profile — shows under the box.
 *
 * A lead, director, admin or ops also gets a note box: what the TA should do
 * with this person, shown on the row as "TA Lead · <name> sent this note"
 * (25 Sep). A TA's box is unchanged.
 */
export function AddLinkForm({ openingId, canNote = false }: { openingId: string; canNote?: boolean }) {
  const add = useInline(addLinkInline);
  const button = (
    <SubmitButton
      busy={add.pending}
      locked={add.pending}
      pendingLabel="Adding…"
      className="rounded-lg bg-brand px-8 py-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      Add to table
    </SubmitButton>
  );
  return (
    <form
      onSubmit={(e) => {
        const form = e.currentTarget;
        const { formData } = submitted(e);
        add.run(formData);
        // Ready for the next paste; a refusal leaves nothing worth keeping
        // that the message does not already repeat.
        form.reset();
      }}
      className="mb-6"
    >
      <input type="hidden" name="openingId" value={openingId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="relative min-w-[280px] flex-[2]">
          <span className="absolute -top-2 left-3 bg-paper px-1.5 text-[11px] text-ink-soft">LinkedIn profile</span>
          <input
            name="url"
            required
            inputMode="url"
            autoComplete="off"
            placeholder="linkedin.com/in/their-name"
            className="w-full rounded-lg border border-rule bg-surface px-3.5 py-3 text-[13.5px] outline-none transition-colors placeholder:text-ink-faint focus:border-brand"
          />
        </label>
        <label className="relative min-w-[200px] flex-1">
          <span className="absolute -top-2 left-3 bg-paper px-1.5 text-[11px] text-ink-soft">
            Name <span className="text-ink-faint">optional</span>
          </span>
          <input
            name="name"
            autoComplete="off"
            placeholder="Read from the link if blank"
            className="w-full rounded-lg border border-rule bg-surface px-3.5 py-3 text-[13.5px] outline-none transition-colors placeholder:text-ink-faint focus:border-brand"
          />
        </label>
        {!canNote && button}
      </div>
      {canNote && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="relative min-w-[280px] flex-1">
            <span className="absolute -top-2 left-3 bg-paper px-1.5 text-[11px] text-ink-soft">
              Note for the TA <span className="text-ink-faint">optional</span>
            </span>
            <textarea
              name="note"
              rows={2}
              maxLength={2000}
              placeholder="What the TA should know or do with this person"
              className="w-full resize-y rounded-lg border border-rule bg-surface px-3.5 py-3 text-[13.5px] leading-relaxed outline-none transition-colors placeholder:text-ink-faint focus:border-brand"
            />
          </label>
          {button}
        </div>
      )}
      <ActionNote result={add.result} className="mt-3" />
    </form>
  );
}
