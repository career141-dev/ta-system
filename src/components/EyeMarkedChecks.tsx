"use client";

import { useEffect, useRef } from "react";
import type { EyeMarkedProgress } from "@/lib/eyeMarked";

export function EyeMarkedChecks({ openingId, items }: { openingId: string; items: EyeMarkedProgress[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const blocked = items.filter((item) => item.blocked);
  const pending = items.filter((item) => !item.complete);
  // The form also refuses a submit from Enter; the server checks a fresh snapshot.
  useEffect(() => {
    const form = document.getElementById("eod-send");
    const prevent = (event: Event) => {
      if (!blocked.length) return;
      event.preventDefault();
      dialog.current?.showModal();
    };
    form?.addEventListener("submit", prevent);
    return () => form?.removeEventListener("submit", prevent);
  }, [blocked.length]);
  useEffect(() => {
    if (blocked.length && !dialog.current?.open) dialog.current?.showModal();
  }, [blocked.length]);
  if (!pending.length) return null;
  return (
    <section className="rounded-xl border border-rule bg-surface p-5">
      <h3 className="text-[13.5px] font-semibold">Eye-marked checks</h3>
      <p className="mt-2 text-[13px] text-ink-soft">
        {blocked.length ? `${blocked.length} marked profiles need action before sending.` : `${pending.length} marked profiles are pending. You can send while waiting for their CVs.`}
      </p>
      <button type="button" onClick={() => dialog.current?.showModal()} className="mt-3 text-[13px] font-medium text-brand hover:underline">Review marked profiles</button>
      <dialog ref={dialog} aria-labelledby="eye-checks-title" className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-lg overflow-y-auto border-l border-rule bg-surface p-6 text-ink backdrop:bg-black/30">
        <div className="flex items-center justify-between gap-4">
          <h2 id="eye-checks-title" className="text-[17px] font-semibold">Eye-marked profiles</h2>
          <button type="button" onClick={() => dialog.current?.close()} className="text-[13px] text-brand">Close</button>
        </div>
        <p className="my-4 text-[13px] text-ink-soft">Log the contact attempt and request the CV. If the CV is received, link it and move the candidate to Director Review before sending.</p>
        <ul className="divide-y divide-rule">
          {pending.map((item) => (
            <li key={item.id} className="py-4">
              <p className="text-[13.5px] font-medium">{item.name}</p>
              <p className={`mt-1 text-[12.5px] ${item.blocked ? "text-warn" : "text-ink-soft"}`}>{item.status}{item.blocked ? " — required" : ""}</p>
              <a href={`/openings/${openingId}/hh#eye-${item.id}`} className="mt-2 inline-block text-[12.5px] text-brand hover:underline">Open profile and log progress</a>
              {item.applicationId && <a href={`/openings/${openingId}/candidate/${item.applicationId}`} className="ml-4 text-[12.5px] text-brand hover:underline">Open candidate</a>}
            </li>
          ))}
        </ul>
      </dialog>
    </section>
  );
}
