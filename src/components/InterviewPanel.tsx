import type { Interview } from "@/data/types";
import { timeAt } from "@/lib/format";
import { confirmInterview, setInterviewOutcome, setInterviewResult } from "@/app/actions";
import { SubmitButton } from "./Submit";

/**
 * The interview, and the two facts about it that somebody has to record.
 *
 * These controls did not exist. The SLA rules chase a TA at four hours out to
 * confirm the candidate is attending, and at the day after to follow up on how
 * it went — and there was no button for either, so both alerts asked for
 * something the system could not accept.
 *
 * Attendance and result are separate on purpose: a candidate can turn up and
 * be turned down, and one field cannot say both.
 */
export function InterviewPanel({
  interview,
  openingId,
  locked,
}: {
  interview: Interview;
  openingId: string;
  locked: boolean;
}) {
  const box = "rounded-2xl border border-rule bg-surface p-5 shadow-[0_1px_2px_rgba(23,28,24,0.04)]";
  const ids = (
    <>
      <input type="hidden" name="interviewId" value={interview.id} />
      <input type="hidden" name="openingId" value={openingId} />
    </>
  );
  const past = interview.scheduledAt < Date.now();

  return (
    <div className={`mt-3 ${box}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">
          Interview — round {interview.round}
        </h2>
        <span className="text-[12px] text-ink-faint">
          {timeAt(interview.scheduledAt)} · {interview.mode.replace(/_/g, " ")} ·{" "}
          {interview.location}
        </span>
      </div>

      {interview.interviewers.length > 0 && (
        <p className="mt-1 text-[12.5px] text-ink-soft">
          With {interview.interviewers.join(", ")}
          {interview.durationMins ? ` · ${interview.durationMins} minutes` : ""}
        </p>
      )}

      {locked ? null : (
        <div className="mt-3 grid gap-3">
          {/* 1. Are they coming? This is what the four-hour escalation wants. */}
          {!interview.confirmedAt ? (
            <form action={confirmInterview} className="flex flex-wrap items-center gap-2">
              {ids}
              <SubmitButton
                pendingLabel="Saving…"
                className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-60"
              >
                They have confirmed they are attending
              </SubmitButton>
              <span className="text-[11.5px] text-warn">
                Unconfirmed — this is what the reminder is chasing.
              </span>
            </form>
          ) : (
            <p className="text-[12.5px] text-brand">
              Attendance confirmed {timeAt(interview.confirmedAt)}.
            </p>
          )}

          {/* 2. Did they turn up? Only worth asking once it has happened. */}
          {past && interview.outcome === "pending" && (
            <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
              <span className="text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                Did it happen
              </span>
              {(["attended", "no_show", "cancelled"] as const).map((o) => (
                <form key={o} action={setInterviewOutcome}>
                  {ids}
                  <input type="hidden" name="outcome" value={o} />
                  <SubmitButton
                    tone="dark"
                    pendingLabel="Saving…"
                    className="rounded border border-rule-strong px-3 py-1.5 text-[12.5px] disabled:opacity-60"
                  >
                    {o === "attended" ? "They attended" : o === "no_show" ? "No show" : "Cancelled"}
                  </SubmitButton>
                </form>
              ))}
            </div>
          )}

          {interview.outcome !== "pending" && (
            <p className="text-[12.5px] text-ink-soft">
              {interview.outcome === "attended"
                ? "Attended."
                : interview.outcome === "no_show"
                  ? "Did not turn up."
                  : "Cancelled."}
            </p>
          )}

          {/* 3. How did it go? A different question, asked of the client. */}
          {interview.outcome === "attended" && (
            <form action={setInterviewResult} className="grid gap-2 border-t border-rule pt-3">
              {ids}
              <span className="text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                What the client said
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  name="result"
                  defaultValue={interview.result}
                  className="rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
                >
                  <option value="pending">Not heard back yet</option>
                  <option value="passed">Passed — take them forward</option>
                  <option value="on_hold">On hold</option>
                  <option value="failed">Not going forward</option>
                </select>
                <select
                  name="clientRating"
                  defaultValue={interview.clientRating ?? ""}
                  className="rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
                >
                  <option value="">No rating</option>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {n} out of 5
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                name="clientFeedback"
                rows={2}
                defaultValue={interview.clientFeedback ?? ""}
                placeholder="Their words, as close as you can get them — this is what decides the next set."
                className="w-full rounded border border-rule bg-paper px-2.5 py-2 text-[12.5px]"
              />
              <SubmitButton
                tone="dark"
                pendingLabel="Saving…"
                className="justify-self-start rounded border border-rule-strong px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-60"
              >
                Save the feedback
              </SubmitButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
