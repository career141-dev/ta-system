"use client";

import { useFormStatus } from "react-dom";
import { LoadingProgress, REPORT_STEPS } from "./LoadingScenes";

/**
 * The Ask box, aware of its own submit.
 *
 * A question here runs a model call and then the report itself — a few
 * seconds in the ordinary case, longer if the model is slow. Before this the
 * button gave no sign it had been pressed: nothing disabled, nothing moving,
 * so a TA who clicked twice, or gave up and left the page, had no way to tell
 * whether it was still working (17 September). Same fix as sourcing, research
 * and the database search bar — named steps instead of a page that looks
 * stopped.
 *
 * `useFormStatus` only answers inside the form it names, so the button and
 * the progress beneath it have to live together in one client component; the
 * page around it, and the action itself, stay exactly as they were.
 */
export function AskReportForm({
  action,
  defaultValue,
}: {
  action: (formData: FormData) => Promise<void>;
  defaultValue: string;
}) {
  return (
    <form action={action} className="mb-6">
      <Bar defaultValue={defaultValue} />
    </form>
  );
}

function Bar({ defaultValue }: { defaultValue: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-rule bg-surface p-2.5 shadow-[0_1px_2px_rgba(23,28,24,0.04)] focus-within:border-brand-line">
        <input
          name="question"
          defaultValue={defaultValue}
          placeholder="How many placements has each TA made this quarter?"
          disabled={pending}
          className="min-w-[280px] flex-1 bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-ink-faint disabled:text-ink-faint"
        />
        <button
          disabled={pending}
          aria-busy={pending}
          className="rounded-xl bg-brand px-6 py-3 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Working…" : "Show me"}
        </button>
      </div>
      {pending ? (
        <div className="mt-2.5">
          <LoadingProgress steps={REPORT_STEPS} heading="Building your report" />
        </div>
      ) : (
        <p className="mt-2.5 px-1 text-[11.5px] text-ink-faint">
          Try &ldquo;roles open more than 30 days&rdquo; · &ldquo;why candidates dropped out at
          CKDL&rdquo; · &ldquo;who we approached but never reached&rdquo;
        </p>
      )}
    </>
  );
}
