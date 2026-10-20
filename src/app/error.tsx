"use client";

import { ProblemState } from "@/components/ProblemState";

/**
 * What a page shows when it throws (28 Sep).
 *
 * Next keeps the technical failure in the server log. The TA gets a short
 * recovery step instead of implementation details that cannot help them.
 */
export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <ProblemState
      title="This page could not load"
      message="Nothing you saved before this is lost. Try again. If the problem continues, contact an administrator."
      showBack={false}
    >
      <button onClick={() => retry()} className="mt-5 rounded bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white">
        Try again
      </button>
    </ProblemState>
  );
}
