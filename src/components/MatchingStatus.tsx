import { getCurrentUser } from "@/lib/session";
import { timeAt } from "@/lib/format";
import { matchingSnapshot } from "@/lib/matchingSnapshot";
import { findMatchesNow } from "@/app/actions";
import { AutoRefresh } from "@/app/settings/AutoRefresh";
import { LoadingProgress, MATCHING_STEPS } from "./LoadingScenes";
import { Spinner, SubmitButton } from "./Submit";

/**
 * Whether database matching is running for this opening, and what it did.
 *
 * Matching runs in the background after the JD is approved or its details are
 * saved, and nothing on screen said so: testers could not tell a run in
 * progress from one that had failed, or from one that found nobody (25 Sep).
 * While it runs the page re-reads itself every few seconds, so the matches
 * appear without a reload; the ones already listed stay usable meanwhile.
 *
 * `full` shows the step-by-step scene — for a list that is still empty.
 */
export async function MatchingStatus({ openingId, full = false }: { openingId: string; full?: boolean }) {
  // The state and the permission are shared with the mobile API (lib/matchingSnapshot).
  const snapshot = await matchingSnapshot(await getCurrentUser(), openingId);
  if (!snapshot) return null;
  const { state, canRun } = snapshot;

  const runAgain = (label: string) =>
    canRun ? (
      <form action={findMatchesNow} className="shrink-0">
        <input type="hidden" name="openingId" value={openingId} />
        <SubmitButton
          pendingLabel="Starting…"
          tone="dark"
          className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-tag"
        >
          {label}
        </SubmitButton>
      </form>
    ) : null;

  const box = "mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[12.5px] leading-snug";

  if (state.kind === "reading" || state.kind === "running") {
    const title = state.kind === "reading" ? "Reading the job details — matching starts next" : "Matching the database against this job…";
    if (full) {
      return (
        <div className="mt-5">
          <LoadingProgress
            steps={MATCHING_STEPS}
            heading="Matching the database"
            note="usually under two minutes"
            since={state.since}
          />
          <p className="mt-2 text-center">
            <AutoRefresh seconds={3} />
          </p>
        </div>
      );
    }
    return (
      <div role="status" aria-live="polite" className={`${box} border-brand/25 bg-brand-soft`}>
        <span className="flex items-center gap-2.5 text-brand">
          <Spinner tone="dark" />
          <span>
            <span className="font-medium">{title}</span>
            <span className="ml-1.5 text-ink-soft">The list updates by itself; the matches already here can be used meanwhile.</span>
          </span>
        </span>
        <AutoRefresh seconds={3} />
      </div>
    );
  }

  if (state.kind === "slow" || state.kind === "error") {
    const message =
      state.kind === "slow"
        ? `Matching started at ${timeAt(state.since)} and has not finished — far longer than it takes, so it has most likely stopped.`
        : (state.reason ?? "The matching engine reported an error, so no new matches were added.");
    return (
      <div role="alert" className={`${box} ${state.kind === "slow" ? "border-warn/40 bg-warn-soft text-warn" : "border-danger/30 bg-danger-soft text-danger"}`}>
        <span>{message}</span>
        {runAgain("Run matching again")}
      </div>
    );
  }

  if (state.kind === "finished") {
    return (
      <div role="status" className={`${box} border-brand/25 bg-brand-soft text-brand`}>
        <span>
          <span className="font-medium">
            ✓ Matching finished at {timeAt(state.at)} —{" "}
            {state.added === 0 ? "no new matches" : `${state.added} new ${state.added === 1 ? "match" : "matches"} added`}.
          </span>
          {state.note && <span className="ml-1.5 text-ink-soft">{state.note}</span>}
        </span>
        {runAgain("Run again")}
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-[12px] text-ink-faint">
      <span>{state.lastAt ? `Last matched against the database ${timeAt(state.lastAt)}.` : "Not matched against the database yet."}</span>
      {runAgain(state.lastAt ? "Run matching again" : "Run matching")}
    </div>
  );
}
