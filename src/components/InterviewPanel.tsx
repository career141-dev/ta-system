import type { Interview, InterviewFeedback, User } from "@/data/types";
import { timeAt } from "@/lib/format";
import {
  confirmInterview, editInterview, rescheduleInterview, saveInterviewFeedback, scheduleInterview,
  setInterviewOutcome, setInterviewResult,
} from "@/app/actions";
import {
  INTERVIEW_STATUS_LABEL, RATING_LABEL, RECOMMENDATION_LABEL, interviewStatus, mayChangeFeedback, whenLabel,
  type InterviewStatus,
} from "@/lib/interviews";
import { SubmitButton } from "./Submit";

/**
 * Every interview a candidate has on this opening, each with its own name,
 * time, status, feedback and history (28 Sep).
 *
 * There used to be one: booking again cancelled the pending one, so a
 * technical and an HR round could not both be on, and moving a time lost the
 * old one. Now each booking stands on its own, a reschedule keeps what it
 * replaced, and each interviewer leaves their own scored feedback.
 *
 * Attendance and result are separate on purpose: a candidate can turn up and
 * be turned down, and one field cannot say both.
 */

// A plain string, not form.tsx's inputClass: that module is a client one, and
// a server component importing a constant from it gets a reference, not text.
const input =
  "w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[12.5px] text-ink outline-none focus:border-brand";
const small = "mb-1 block text-[11.5px] text-ink-soft";
const button =
  "rounded border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-60";
const summary = "cursor-pointer select-none text-[12.5px] font-medium text-ink-soft hover:text-ink";

const STATUS_TONE: Record<InterviewStatus, string> = {
  scheduled: "bg-brand-soft text-brand",
  rescheduled: "bg-warn-soft text-warn",
  completed: "bg-ink/10 text-ink",
  cancelled: "bg-rule text-ink-faint",
  no_show: "bg-danger-soft text-danger",
};

/** Colombo wall-clock parts, to pre-fill the reschedule form with the current time. */
function colomboParts(ts: number): { date: string; time: string } {
  const s = new Date(ts).toLocaleString("sv-SE", { timeZone: "Asia/Colombo" }); // "2026-10-03 10:00:00"
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

export function Interviews({
  interviews,
  appId,
  openingId,
  canBook,
  locked,
  canFeedback,
  user,
  nameOf,
}: {
  interviews: Interview[];
  appId: string;
  openingId: string;
  /** Only a client-shortlisted or interviewing candidate can be booked. */
  canBook: boolean;
  /** Not allowed to book, reschedule, edit or change status (opening.act). */
  locked: boolean;
  /** Allowed to give feedback (interview.feedback). */
  canFeedback: boolean;
  user: User;
  nameOf: (userId: string) => string;
}) {
  if (!interviews.length && (locked || !canBook)) return null;
  const box = "rounded-2xl border border-rule bg-surface p-5 shadow-[0_1px_2px_rgba(23,28,24,0.04)]";

  return (
    <section className={`mt-3 ${box}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">
          Interviews{interviews.length ? ` · ${interviews.length}` : ""}
        </h2>
        {!locked && canBook && (
          <details className="w-full sm:w-auto">
            <summary className={summary}>+ Book another interview</summary>
            <form action={scheduleInterview} className="mt-3 grid gap-2.5 sm:w-[420px]">
              <input type="hidden" name="appId" value={appId} />
              <input type="hidden" name="openingId" value={openingId} />
              <label>
                <span className={small}>Interview name</span>
                <input name="title" required placeholder="Technical interview" className={input} />
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <label><span className={small}>Date</span><input name="date" type="date" required className={input} /></label>
                <label><span className={small}>Time</span><input name="time" type="time" required className={input} /></label>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <label>
                  <span className={small}>How</span>
                  <select name="mode" defaultValue="in_person" className={input}>
                    <option value="in_person">In person</option>
                    <option value="video">Video</option>
                    <option value="phone">Phone</option>
                  </select>
                </label>
                <label>
                  <span className={small}>Minutes</span>
                  <input name="durationMins" type="number" min={15} step={15} defaultValue={45} className={input} />
                </label>
              </div>
              <label><span className={small}>Where, or the link</span><input name="location" className={input} /></label>
              <label><span className={small}>Interviewers (comma separated)</span><input name="interviewers" className={input} /></label>
              <label><span className={small}>Anything to note</span><input name="notes" className={input} /></label>
              <SubmitButton pendingLabel="Booking…" className="justify-self-start rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60">
                Book interview
              </SubmitButton>
            </form>
          </details>
        )}
      </div>

      <div className="mt-3 grid gap-3">
        {interviews.map((iv) => (
          <InterviewCard
            key={iv.id}
            interview={iv}
            openingId={openingId}
            locked={locked}
            canFeedback={canFeedback}
            user={user}
            nameOf={nameOf}
          />
        ))}
      </div>
    </section>
  );
}

function InterviewCard({
  interview: iv,
  openingId,
  locked,
  canFeedback,
  user,
  nameOf,
}: {
  interview: Interview;
  openingId: string;
  locked: boolean;
  canFeedback: boolean;
  user: User;
  nameOf: (userId: string) => string;
}) {
  const ids = (
    <>
      <input type="hidden" name="interviewId" value={iv.id} />
      <input type="hidden" name="openingId" value={openingId} />
    </>
  );
  const status = interviewStatus(iv);
  const past = iv.scheduledAt < Date.now();
  const when = colomboParts(iv.scheduledAt);
  const mine = iv.feedback.find((f) => f.byUserId === user.id);

  return (
    <article className="rounded-xl border border-rule p-4">
      {/* What it is, when, and where it stands. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">
          {iv.title ?? `Interview — round ${iv.round}`}
          <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}>
            {INTERVIEW_STATUS_LABEL[status]}
          </span>
        </h3>
        <span className="text-[12px] text-ink-faint">
          {whenLabel(iv.scheduledAt)} · {iv.mode.replace(/_/g, " ")}
          {iv.location ? ` · ${iv.location}` : ""}
          {iv.durationMins ? ` · ${iv.durationMins} min` : ""}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-soft">
        Interviewer{iv.interviewers.length === 1 ? "" : "s"}: {iv.interviewers.join(", ") || "not named yet"}
      </p>
      {iv.notes && <p className="mt-1 text-[12.5px] text-ink-soft">Note: {iv.notes}</p>}

      {/* 1. Are they coming? This is what the four-hour escalation wants. */}
      {iv.outcome === "pending" &&
        (iv.confirmedAt ? (
          <p className="mt-2 text-[12.5px] text-brand">Attendance confirmed {timeAt(iv.confirmedAt)}.</p>
        ) : locked ? (
          <p className="mt-2 text-[11.5px] text-warn">Attendance not confirmed yet.</p>
        ) : (
          <form action={confirmInterview} className="mt-2 flex flex-wrap items-center gap-2">
            {ids}
            <SubmitButton pendingLabel="Saving…" className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-60">
              They have confirmed they are attending
            </SubmitButton>
            <span className="text-[11.5px] text-warn">Unconfirmed — this is what the reminder is chasing.</span>
          </form>
        ))}

      {!locked && (
        <div className="mt-3 grid gap-2 border-t border-rule pt-3">
          {/* 2. Status. Completed once it happened; the time guard only
              nudges — a status can be corrected either way. */}
          <form action={setInterviewOutcome} className="flex flex-wrap items-end gap-2">
            {ids}
            <label>
              <span className={small}>Status</span>
              <select
                name="outcome"
                defaultValue={status === "rescheduled" ? "scheduled" : status === "scheduled" && past ? "completed" : status}
                className={input}
              >
                <option value="scheduled">Scheduled</option>
                <option value="completed">Completed</option>
                <option value="no_show">No show</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label className="min-w-[180px] flex-1">
              <span className={small}>Reason (optional)</span>
              <input name="reason" placeholder="Client cancelled the slot" className={input} />
            </label>
            <SubmitButton tone="dark" pendingLabel="Saving…" className={button}>Update status</SubmitButton>
          </form>

          {/* 3. A new time for the same interview; the old one stays below. */}
          {iv.outcome !== "attended" && (
            <details>
              <summary className={summary}>Reschedule</summary>
              <form action={rescheduleInterview} className="mt-2 grid gap-2.5 sm:grid-cols-2">
                {ids}
                <label><span className={small}>New date</span><input name="date" type="date" required defaultValue={when.date} className={input} /></label>
                <label><span className={small}>New time</span><input name="time" type="time" required defaultValue={when.time} className={input} /></label>
                <label>
                  <span className={small}>How</span>
                  <select name="mode" defaultValue={iv.mode} className={input}>
                    <option value="in_person">In person</option>
                    <option value="video">Video</option>
                    <option value="phone">Phone</option>
                  </select>
                </label>
                <label><span className={small}>Where, or the link</span><input name="location" defaultValue={iv.location} className={input} /></label>
                <label className="sm:col-span-2">
                  <span className={small}>Why it moved</span>
                  <input name="reason" placeholder="Interviewer unavailable" className={input} />
                </label>
                <SubmitButton tone="dark" pendingLabel="Saving…" className={`${button} justify-self-start`}>Reschedule</SubmitButton>
              </form>
            </details>
          )}

          <details>
            <summary className={summary}>Edit details</summary>
            <form action={editInterview} className="mt-2 grid gap-2.5 sm:grid-cols-2">
              {ids}
              <label><span className={small}>Interview name</span><input name="title" defaultValue={iv.title ?? ""} className={input} /></label>
              <label><span className={small}>Minutes</span><input name="durationMins" type="number" min={15} step={15} defaultValue={iv.durationMins ?? ""} className={input} /></label>
              <label className="sm:col-span-2"><span className={small}>Interviewers (comma separated)</span><input name="interviewers" defaultValue={iv.interviewers.join(", ")} className={input} /></label>
              <label className="sm:col-span-2"><span className={small}>Notes</span><input name="notes" defaultValue={iv.notes ?? ""} className={input} /></label>
              <SubmitButton tone="dark" pendingLabel="Saving…" className={`${button} justify-self-start`}>Save details</SubmitButton>
            </form>
          </details>
        </div>
      )}

      {/* 4. The client's verdict — a different question from the scores. */}
      {iv.outcome === "attended" &&
        (locked ? (
          iv.result !== "pending" || iv.clientFeedback ? (
            <p className="mt-3 border-t border-rule pt-3 text-[12.5px] text-ink-soft">
              Client: {iv.result.replace(/_/g, " ")}
              {iv.clientRating ? ` · ${iv.clientRating}/5` : ""}
              {iv.clientFeedback ? ` — ${iv.clientFeedback}` : ""}
            </p>
          ) : null
        ) : (
          <form action={setInterviewResult} className="mt-3 grid gap-2 border-t border-rule pt-3">
            {ids}
            <span className="text-[11px] uppercase tracking-[0.08em] text-ink-faint">What the client said</span>
            <div className="flex flex-wrap items-center gap-2">
              <select name="result" defaultValue={iv.result} className="rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]">
                <option value="pending">Not heard back yet</option>
                <option value="passed">Passed — take them forward</option>
                <option value="on_hold">On hold</option>
                <option value="failed">Not going forward</option>
              </select>
              <select name="clientRating" defaultValue={iv.clientRating ?? ""} className="rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]">
                <option value="">No rating</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>{n} out of 5</option>
                ))}
              </select>
            </div>
            <textarea
              name="clientFeedback"
              rows={2}
              defaultValue={iv.clientFeedback ?? ""}
              placeholder="Their words, as close as you can get them — this is what decides the next set."
              className="w-full rounded border border-rule bg-paper px-2.5 py-2 text-[12.5px]"
            />
            <SubmitButton tone="dark" pendingLabel="Saving…" className={`${button} justify-self-start`}>Save the client&apos;s verdict</SubmitButton>
          </form>
        ))}

      {/* 5. Interviewer feedback: one entry per person, visible to everyone
          who can see the candidate, editable by its author or a lead. */}
      <div className="mt-3 grid gap-2 border-t border-rule pt-3">
        <span className="text-[11px] uppercase tracking-[0.08em] text-ink-faint">Interviewer feedback</span>
        {iv.feedback.length === 0 && <p className="text-[12.5px] text-ink-faint">None yet.</p>}
        {iv.feedback.map((f) => (
          <div key={f.byUserId} className="rounded-lg bg-paper p-3">
            <FeedbackView f={f} nameOf={nameOf} />
            {canFeedback && mayChangeFeedback(user, f) && (
              <details className="mt-2">
                <summary className={summary}>{f.byUserId === user.id ? "Update your feedback" : "Correct this feedback"}</summary>
                <FeedbackForm ids={ids} f={f} forUserId={f.byUserId} />
              </details>
            )}
          </div>
        ))}
        {canFeedback && !mine && (
          <details>
            <summary className={summary}>+ Add your feedback</summary>
            <FeedbackForm ids={ids} f={undefined} forUserId={user.id} defaultName={iv.interviewers[0] ?? user.name} />
          </details>
        )}
      </div>

      {/* 6. What changed, and what it was before. */}
      {iv.history.length > 0 && (
        <details className="mt-3 border-t border-rule pt-3">
          <summary className={summary}>History · {iv.history.length}</summary>
          <ol className="mt-2 grid gap-1">
            {[...iv.history].reverse().map((h, n) => (
              <li key={n} className="text-[12px] text-ink-soft">
                <span className="text-ink-faint">{whenLabel(h.at)} · {nameOf(h.byUserId)}</span> — {h.detail}
                {h.reason ? <em className="text-ink-faint"> ({h.reason})</em> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

function FeedbackView({ f, nameOf }: { f: InterviewFeedback; nameOf: (id: string) => string }) {
  const rated = (Object.keys(RATING_LABEL) as (keyof typeof RATING_LABEL)[]).filter((k) => f.ratings[k] !== null);
  return (
    <>
      <p className="text-[12.5px] font-medium">
        {f.interviewer}
        {f.recommendation && <span className="ml-2 text-ink-soft">· {RECOMMENDATION_LABEL[f.recommendation]}</span>}
      </p>
      {rated.length > 0 && (
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {rated.map((k) => (
            <div key={k}>
              <dt className="inline text-ink-faint">{RATING_LABEL[k]}: </dt>
              <dd className="inline font-medium">{f.ratings[k]}/5</dd>
            </div>
          ))}
        </dl>
      )}
      {f.comments && <p className="mt-1 whitespace-pre-line text-[12.5px] text-ink-soft">{f.comments}</p>}
      <p className="mt-1 text-[11px] text-ink-faint">
        Entered by {nameOf(f.byUserId)} · {whenLabel(f.at)}
        {f.updatedAt !== f.at ? ` · updated ${whenLabel(f.updatedAt)}` : ""}
      </p>
    </>
  );
}

function FeedbackForm({
  ids,
  f,
  forUserId,
  defaultName,
}: {
  ids: React.ReactNode;
  f: InterviewFeedback | undefined;
  forUserId: string;
  defaultName?: string;
}) {
  return (
    <form action={saveInterviewFeedback} className="mt-2 grid gap-2.5">
      {ids}
      <input type="hidden" name="forUserId" value={forUserId} />
      <label>
        <span className={small}>Interviewer</span>
        <input name="interviewer" required defaultValue={f?.interviewer ?? defaultName} className={input} />
      </label>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {(Object.keys(RATING_LABEL) as (keyof typeof RATING_LABEL)[]).map((k) => (
          <label key={k}>
            <span className={small}>{RATING_LABEL[k]}</span>
            <select name={k} defaultValue={f?.ratings[k] ?? ""} className={input}>
              <option value="">Not rated</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>{n} / 5</option>
              ))}
            </select>
          </label>
        ))}
        <label>
          <span className={small}>Recommendation</span>
          <select name="recommendation" defaultValue={f?.recommendation ?? ""} className={input}>
            <option value="">None</option>
            {Object.entries(RECOMMENDATION_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span className={small}>Comments — performance, behaviour, what stood out</span>
        <textarea name="comments" rows={3} defaultValue={f?.comments ?? ""} className={input} />
      </label>
      <SubmitButton tone="dark" pendingLabel="Saving…" className={`${button} justify-self-start`}>
        {f ? "Update feedback" : "Save feedback"}
      </SubmitButton>
    </form>
  );
}
