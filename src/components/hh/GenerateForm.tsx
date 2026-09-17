"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoadingProgress, RESEARCH_STEPS, SOURCING_STEPS } from "../LoadingScenes";

/**
 * The Generate bar as a form, so the bar itself knows a run is under way.
 *
 * The whole bar is the form because `useFormStatus` only answers inside one:
 * the progress has to open under the label, across the full width, not beside
 * a button. Last run's error or count is hidden while the new run works — it
 * describes a result that is about to be replaced.
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
  action: (formData: FormData) => Promise<void>;
  blocked: boolean;
  hasResult: boolean;
  needs: "grounded" | "sourcing";
  /** The label and the line under it. */
  children: ReactNode;
  /** Missing settings, last run's error or count. */
  notes: ReactNode;
}) {
  return (
    <form action={action} className="mb-5 rounded-xl border border-rule bg-surface px-5 py-4">
      <input type="hidden" name="openingId" value={openingId} />
      <Body blocked={blocked} hasResult={hasResult} needs={needs} notes={notes}>
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
}: {
  blocked: boolean;
  hasResult: boolean;
  needs: "grounded" | "sourcing";
  notes: ReactNode;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
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
