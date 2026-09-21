"use client";

import { verifyRefereeInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";

/** "Verify on LinkedIn" for one referee — the answer shows under it (plan 5.2). */
export function VerifyReferee({ refereeId, openingId }: { refereeId: string; openingId: string }) {
  const check = useInline(verifyRefereeInline);
  return (
    <form onSubmit={(e) => check.run(submitted(e).formData)} className="mt-2 flex flex-col items-end gap-1.5">
      <input type="hidden" name="refereeId" value={refereeId} />
      <input type="hidden" name="openingId" value={openingId} />
      <SubmitButton
        busy={check.pending}
        locked={check.pending}
        pendingLabel="Checking LinkedIn…"
        tone="dark"
        className="rounded-full border border-brand-line px-3 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
      >
        Verify on LinkedIn
      </SubmitButton>
      <ActionNote result={check.result} className="max-w-[360px] text-left" />
    </form>
  );
}
