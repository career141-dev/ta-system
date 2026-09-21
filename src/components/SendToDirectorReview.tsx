"use client";

import Link from "next/link";
import { moveStageInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";

/**
 * The step after a finished follow-up, as a button.
 *
 * Follow-up said "ready for Director review" and stopped there; moving them
 * meant finding Change stage in the row menu (testing, 21 Sep). The backend
 * still checks the CV and the salary answers are in, and says so here if not.
 */
export function SendToDirectorReview({ applicationId, openingId }: { applicationId: string; openingId: string }) {
  const move = useInline(moveStageInline);
  return (
    <form onSubmit={(e) => move.run(submitted(e).formData)} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="appId" value={applicationId} />
      <input type="hidden" name="openingId" value={openingId} />
      <input type="hidden" name="stage" value="director_review" />
      <span className="text-[12.5px] text-brand">Everything is in.</span>
      {move.result?.ok ? (
        <Link href={`/openings/${openingId}/pipeline/director_review`} className="text-[12.5px] font-medium text-accent hover:underline">
          Open Director Review →
        </Link>
      ) : (
        <SubmitButton
          busy={move.pending}
          locked={move.pending}
          pendingLabel="Sending…"
          className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          Send to Director Review
        </SubmitButton>
      )}
      <ActionNote result={move.result} className="w-full" />
    </form>
  );
}
