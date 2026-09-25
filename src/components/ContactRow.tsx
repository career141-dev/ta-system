"use client";

import { useEffect, useState } from "react";
import { updateCandidateContact, updateCandidateContactInline } from "@/app/actions";
import { Confirm } from "./Confirm";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";

/**
 * A candidate's email or phone, corrected where it is read — finding 13.
 *
 * These controls were drawn with tooltips and no handlers, which is worse than
 * not drawing them: a TA with a wrong number clicks edit, gets nothing, and
 * concludes the product is broken. There are two of them rather than three,
 * because the record holds one email and one phone — "add another" had nowhere
 * to put a second.
 */
export function ContactRow({
  kind,
  value,
  candidateId,
  openingId,
  locked,
}: {
  kind: "email" | "phone";
  value: string | null;
  candidateId: string;
  openingId: string;
  locked: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // Saved beside the field, and the editor closes only once it has saved — it
  // used to close on the press, before anyone knew whether it had (25 Sep).
  const save = useInline(updateCandidateContactInline);
  useEffect(() => {
    if (save.result?.ok) setEditing(false);
  }, [save.result]);

  const icon =
    kind === "email" ? (
      <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 4.5l6 4 6-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : (
      <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M5.4 2.5L7 5.2 5.6 6.8c.7 1.5 1.9 2.7 3.4 3.4l1.6-1.4 2.7 1.6-.5 2c-.2.6-.8 1-1.4.9C7.2 12.7 3.3 8.8 2.6 4.4c-.1-.6.3-1.2.9-1.4l1.9-.5z"
          fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
        />
      </svg>
    );

  if (editing) {
    return (
      <form onSubmit={(e) => save.run(submitted(e).formData)} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="candidateId" value={candidateId} />
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="field" value={kind} />
        <span className="w-4 shrink-0 text-ink-faint">{icon}</span>
        <input
          name="value"
          defaultValue={value ?? ""}
          autoFocus
          type={kind === "email" ? "email" : "tel"}
          placeholder={kind === "email" ? "name@company.com" : "+94 77 000 0000"}
          className="w-[230px] rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
        />
        <SubmitButton
          busy={save.pending}
          locked={save.pending}
          pendingLabel="Saving…"
          className="rounded-full bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          Save
        </SubmitButton>
        <button
          type="button"
          disabled={save.pending}
          onClick={() => setEditing(false)}
          className="px-1 text-[12px] text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
        {save.result && !save.result.ok && <ActionNote result={save.result} className="basis-full" />}
      </form>
    );
  }

  const missing = !value;

  return (
    <span className="group inline-flex items-center gap-2">
      <span className="w-4 shrink-0 text-ink-faint">{icon}</span>
      {missing ? (
        <span className="text-[13px] text-ink-faint">{kind === "email" ? "No email on file" : "No number on file"}</span>
      ) : (
        <a
          href={kind === "email" ? `mailto:${value}` : `tel:${value.replace(/[^\d+]/g, "")}`}
          className="font-medium hover:text-accent hover:underline"
        >
          {value}
        </a>
      )}
      {save.result?.ok && <span className="text-[11.5px] text-brand">✓ Saved</span>}

      {!locked && (
        <span className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={missing ? "Add it" : "Correct it"}
            className="grid h-6 w-6 place-items-center rounded text-ink-faint transition-colors hover:bg-tag hover:text-ink"
          >
            {missing ? (
              <svg width={13} height={13} viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width={13} height={13} viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.2 2.4l2.4 2.4-8 8-3.1.7.7-3.1 8-8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            )}
          </button>

          {!missing && (
            <form action={updateCandidateContact} className="inline-flex">
              <input type="hidden" name="candidateId" value={candidateId} />
              <input type="hidden" name="openingId" value={openingId} />
              <input type="hidden" name="field" value={kind} />
              <input type="hidden" name="value" value="" />
              <Confirm
                label="Remove"
                question={`Clear this ${kind}?`}
                confirmLabel="Clear"
                className="grid h-6 w-6 place-items-center rounded text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
              />
            </form>
          )}
        </span>
      )}
    </span>
  );
}
