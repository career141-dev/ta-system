"use client";

import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/inlineResult";
import { ActionNote, submitted, useInline } from "../Submit";
import { LoadingProgress, RESEARCH_STEPS, SOURCING_STEPS } from "../LoadingScenes";

/**
 * The Generate bar as a form, so the bar itself knows a run is under way.
 *
 * The whole bar is the form because `useFormStatus` only answers inside one:
 * the progress has to open under the label, across the full width, not beside
 * a button. Last run's error or count is hidden while the new run works — it
 * describes a result that is about to be replaced.
 *
 * The run's answer — how much it found, or why it did not run — shows under
 * the bar it came from (21 Sep: it used to be a query string, which stayed on
 * the page after a later success and put Benchmark's errors in Research's box).
 */
export function GenerateForm({
  openingId,
  action,
  blocked,
  hasResult,
  needs,
  children,
  notes,
}: {
  openingId: string;
  action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  blocked: boolean;
  hasResult: boolean;
  needs: "grounded" | "sourcing" | "search";
  /** The label and the line under it. */
  children: ReactNode;
  /** Missing settings, last run's error or count. */
  notes: ReactNode;
}) {
  const run = useInline(action);
  return (
    <form onSubmit={(e) => run.run(submitted(e).formData)} className="mb-5 rounded-xl border border-rule bg-surface px-5 py-4">
      <input type="hidden" name="openingId" value={openingId} />
      <Body
        blocked={blocked}
        hasResult={hasResult}
        needs={needs}
        pending={run.pending}
        notes={
          <>
            {/* Once this bar has answered, the page's own note is an older run's —
                an error from before sat beside a new success (review of PR #2).
                A blocked bar never runs, so its "not set up" note stays. */}
            {run.result ? null : notes}
            <ActionNote result={run.result} className="mt-3" />
          </>
        }
      >
        {children}
      </Body>
    </form>
  );
}

function Body({
  blocked,
  hasResult,
  needs,
  notes,
  children,
  pending,
}: {
  blocked: boolean;
  hasResult: boolean;
  needs: "grounded" | "sourcing" | "search";
  notes: ReactNode;
  children: ReactNode;
  pending: boolean;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">{children}</div>
        <button
          disabled={blocked || pending}
          aria-busy={pending}
          className="shrink-0 rounded-full bg-brand px-5 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-rule-strong"
        >
          {pending ? "Working…" : hasResult ? "Run again" : "Generate"}
        </button>
      </div>

      {pending ? (
        <div className="mt-4 border-t border-rule pt-2">
          {needs === "sourcing" ? (
            <LoadingProgress
              bare
              steps={SOURCING_STEPS}
              heading="Finding profiles to headhunt"
              note="usually a minute or two — keep this page open"
            />
          ) : (
            <LoadingProgress
              bare
              steps={RESEARCH_STEPS}
              heading="Researching"
              note="usually about a minute — keep this page open"
            />
          )}
        </div>
      ) : (
        notes
      )}
    </>
  );
}
