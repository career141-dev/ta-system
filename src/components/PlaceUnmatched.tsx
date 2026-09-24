"use client";

import { placeUnmatchedInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "@/components/Submit";

/**
 * One mailbox CV that matched no post: pick the advert it answered, Place.
 * The answer shows under the button; the row leaves the list on the next load.
 */
export function PlaceUnmatched({
  candidateId,
  targets,
}: {
  candidateId: string;
  /** value "openingId" or "openingId:postId". */
  targets: { value: string; label: string }[];
}) {
  const place = useInline(placeUnmatchedInline);
  const placed = !place.pending && place.result?.tone === "ok";
  return (
    <form
      onSubmit={(e) => place.run(submitted(e).formData)}
      className="flex flex-col items-end gap-1.5"
    >
      <input type="hidden" name="candidateId" value={candidateId} />
      {placed ? (
        <span className="text-[12px] font-medium text-brand">✓ Placed</span>
      ) : (
        <div className="flex items-center gap-2">
          <select
            name="target"
            required
            defaultValue=""
            className="max-w-[300px] rounded-full border border-rule bg-surface px-3 py-1.5 text-[12px] outline-none focus:border-brand"
          >
            <option value="" disabled>
              Which job did they apply for?
            </option>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <SubmitButton
            busy={place.pending}
            locked={place.pending}
            pendingLabel="Placing…"
            className="rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            Place
          </SubmitButton>
        </div>
      )}
      {place.result && place.result.tone !== "ok" && <ActionNote result={place.result} className="max-w-[300px]" />}
    </form>
  );
}
