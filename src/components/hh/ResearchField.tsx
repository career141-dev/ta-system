"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editResearchField } from "@/app/actions";

/**
 * One field on the Research form — spec §8A.1.
 *
 * Reads as a label and a value, and becomes an input on click. An empty field
 * says "not found" rather than sitting blank, because the difference between
 * "we did not look" and "we looked and there is nothing" matters to a TA about
 * to tell a client something.
 */
export function ResearchField({
  openingId,
  name,
  label,
  value,
  list = false,
  multiline = false,
  edited = false,
}: {
  openingId: string;
  name: string;
  label: string;
  value: string | string[];
  list?: boolean;
  multiline?: boolean;
  edited?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [currentValue, setCurrentValue] = useState(value);

  useEffect(() => {
    setCurrentValue(value);
  }, [value]);

  const text = Array.isArray(currentValue) ? currentValue.join("; ") : currentValue;
  const empty = text.trim().length === 0;

  const handleSave = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const typed = String(fd.get("value") ?? "");
    const next = list ? typed.split("\n").map((x) => x.trim()).filter(Boolean) : typed;
    setCurrentValue(next);
    setOpen(false);
    startTransition(async () => {
      await editResearchField(fd);
      router.refresh();
    });
  };

  if (open) {
    return (
      <form onSubmit={handleSave}>
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="field" value={name} />
        <span className="mb-1.5 block text-[11.5px] text-ink-soft">{label}</span>
        {multiline || list ? (
          <textarea
            name="value"
            defaultValue={Array.isArray(currentValue) ? currentValue.join("\n") : text}
            rows={multiline ? 8 : 4}
            autoFocus
            disabled={isPending}
            className="w-full rounded-lg border border-brand bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed outline-none"
          />
        ) : (
          <input
            name="value"
            defaultValue={text}
            autoFocus
            disabled={isPending}
            className="w-full rounded-lg border border-brand bg-surface px-3.5 py-2.5 text-[13px] outline-none"
          />
        )}
        <div className="mt-2 flex items-center gap-2">
          <button disabled={isPending} className="rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-60">
            {isPending ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="px-1.5 text-[12px] text-ink-soft hover:text-ink">
            Cancel
          </button>
          {list && <span className="text-[11px] text-ink-faint">One per line</span>}
        </div>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="group block w-full rounded-lg border border-rule px-3.5 py-2.5 text-left transition-colors hover:border-brand-line"
    >
      <span className="mb-1 flex items-center gap-2 text-[11.5px] text-ink-soft">
        {label}
        {edited && <span className="rounded bg-tag px-1.5 py-px text-[10px] text-ink-faint">edited</span>}
        <span className="ml-auto text-[11px] text-ink-faint opacity-0 [@media(hover:none)]:opacity-100 transition-opacity group-hover:opacity-100">
          edit
        </span>
      </span>
      {empty ? (
        <span className="text-[12.5px] italic text-ink-faint">Not found — click to add it</span>
      ) : Array.isArray(value) ? (
        <ul className="flex flex-col gap-1">
          {value.map((v, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-rule-strong" />
              <span>{v}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className={`block whitespace-pre-line text-[13px] leading-relaxed ${multiline ? "" : "truncate"}`}>
          {text}
        </span>
      )}
    </button>
  );
}
