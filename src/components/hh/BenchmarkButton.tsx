"use client";

import { runBenchmarkInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "../Submit";

/**
 * Benchmark's own button, with its own answer.
 *
 * It was a bare form: no sign of the 20–40 seconds it takes, a failure shown
 * in Research's box above, and "nothing found" never shown at all (21 Sep).
 */
export function BenchmarkButton({ openingId, again }: { openingId: string; again: boolean }) {
  const run = useInline(runBenchmarkInline);
  return (
    <form
      onSubmit={(e) => run.run(submitted(e).formData)}
      className="flex w-full flex-col items-end gap-2 sm:w-auto"
    >
      <input type="hidden" name="openingId" value={openingId} />
      <SubmitButton
        busy={run.pending}
        locked={run.pending}
        pendingLabel="Searching…"
        tone="dark"
        className="shrink-0 rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
      >
        {again ? "Run again" : "Find them"}
      </SubmitButton>
      {run.pending && <p className="text-[11.5px] text-ink-faint">Searching the web — usually under a minute. Keep this page open.</p>}
      <ActionNote result={run.result} className="max-w-[520px]" />
    </form>
  );
}
