import type { AiCall, Application, Candidate } from "@/data/types";
import {
  CALL_CONSENT_TEXT,
  MODES,
  modeState,
  nextStep,
  openingLine,
  questionsFor,
  writePolicy,
} from "@/lib/voice";
import { timeAt } from "@/lib/format";
import { finishCall, recordCallAnswer, recordConsent, startCall } from "@/app/actions";

/**
 * The screening call, on the candidate.
 *
 * It exists to fill the four gaps a CV leaves. So the panel only appears where
 * a call is the right next move — a candidate a TA has shortlisted, with
 * something still missing — and it says what is missing before it offers to
 * ring anybody.
 */

const STAGES = ["follow_up", "director_review"];

const FIELD_LABEL: Record<string, string> = {
  currentSalary: "Current salary",
  expectedSalary: "Expected salary",
  noticePeriodDays: "Notice period",
  availability: "Availability",
};

export function ScreeningPanel({
  app,
  candidate,
  openingId,
  roleTitle,
  taName,
  calls,
  inline = false,
}: {
  app: Application;
  candidate: Candidate;
  openingId: string;
  roleTitle: string;
  taName: string;
  calls: AiCall[];
  /** Sitting inside the conversation tab rather than as a band of its own, so
   *  it drops the outer card and the "past calls" list the thread already shows. */
  inline?: boolean;
}) {
  const live = calls.find(
    (c) => c.status === "draft" || c.status === "awaiting_consent" || c.status === "in_progress",
  );
  const past = calls.filter((c) => c !== live);
  const missing = questionsFor(candidate);
  if (!live && (!STAGES.includes(app.stage) || missing.length <= 1)) return null;

  const box = inline
    ? "rounded-xl border border-rule bg-paper p-4"
    : "rounded-2xl border border-rule bg-surface p-5 shadow-[0_1px_2px_rgba(23,28,24,0.04)]";
  const input = "w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]";
  const hidden = (
    <>
      <input type="hidden" name="applicationId" value={app.id} />
      <input type="hidden" name="openingId" value={openingId} />
    </>
  );

  if (!live) {
    return (
      <div className={box}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-semibold">Screening call</h2>
          <span className="text-[12px] text-ink-faint">
            {missing.length} {missing.length === 1 ? "thing" : "things"} to ask about
          </span>
        </div>
        <p className="mt-1 text-[12.5px] text-ink-soft">
          {missing.map((q) => FIELD_LABEL[q.field]).join(", ")}.
        </p>

        <form action={startCall} className="mt-3 flex flex-wrap items-end gap-2">
          {hidden}
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              How
            </span>
            <select name="mode" defaultValue="assisted" className={`${input} w-[210px]`}>
              {MODES.map((m) => {
                const st = modeState(m);
                return (
                  <option key={m} value={m} disabled={!st.available}>
                    {st.label}
                    {st.available ? "" : " — off"}
                  </option>
                );
              })}
            </select>
          </label>
          <button className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
            Start
          </button>
        </form>

        <ul className="mt-3 grid gap-1">
          {MODES.map((m) => {
            const st = modeState(m);
            return (
              <li key={m} className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
                <span className="w-[130px] shrink-0 font-medium text-ink-soft">{st.label}</span>
                <span className={st.available ? "text-brand" : "text-ink-faint"}>
                  {st.available ? "on" : "off"}
                </span>
                <span className="flex-1 text-ink-faint">
                  {st.detail} {st.why}
                </span>
              </li>
            );
          })}
        </ul>

        {!inline && past.length > 0 && (
          <div className="mt-3 border-t border-rule pt-3">
            {past.map((c) => (
              <p key={c.id} className="text-[11.5px] text-ink-faint">
                {modeState(c.mode).label} · {c.status.replace(/_/g, " ")} ·{" "}
                {c.endedAt ? timeAt(c.endedAt) : timeAt(c.startedAt)}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }

  const step = nextStep(live, candidate);
  const mode = modeState(live.mode);

  return (
    <div className={box}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Screening call — {mode.label}</h2>
        <span className="text-[12px] text-ink-faint">
          {writePolicy(live.mode).candidateFields
            ? "Answers will be written to their record"
            : "Dry run — nothing is written"}
        </span>
      </div>

      {live.consent === null && (
        <p className="mt-2 rounded border border-rule bg-paper px-3.5 py-2.5 text-[12.5px] leading-relaxed">
          <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
            Read this first
          </span>
          {openingLine(candidate.fullName, roleTitle, taName)}
          <br />
          <br />
          {CALL_CONSENT_TEXT}
        </p>
      )}

      {step.do === "ask_consent" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={recordConsent}>
            {hidden}
            <input type="hidden" name="callId" value={live.id} />
            <input type="hidden" name="decision" value="granted" />
            <button className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
              They agreed
            </button>
          </form>
          <form action={recordConsent}>
            {hidden}
            <input type="hidden" name="callId" value={live.id} />
            <input type="hidden" name="decision" value="declined" />
            <button className="rounded border border-rule-strong px-3.5 py-1.5 text-[12.5px] font-medium">
              They said no
            </button>
          </form>
          <span className="self-center text-[11.5px] text-ink-faint">
            Saying no ends the call and keeps nothing.
          </span>
        </div>
      )}

      {step.do === "ask" && (
        <>
          <div className="mt-3 rounded border border-rule bg-paper px-3.5 py-3">
            <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Question {step.index} of {step.total} · {FIELD_LABEL[step.question.field]}
            </span>
            <p className="text-[13px]">{step.question.ask}</p>
          </div>
          <form action={recordCallAnswer} className="mt-2 flex flex-wrap items-end gap-2">
            {hidden}
            <input type="hidden" name="callId" value={live.id} />
            <input type="hidden" name="field" value={step.question.field} />
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                What they said
              </span>
              <input
                name="heard"
                placeholder={
                  step.question.field === "availability"
                    ? "afternoons, not Tuesdays"
                    : step.question.field === "noticePeriodDays"
                      ? "2 months"
                      : "150k"
                }
                className={input}
              />
            </label>
            <button className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
              Next
            </button>
          </form>
          <p className="mt-1.5 text-[11.5px] text-ink-faint">
            Type it as they said it. Anything that cannot be read as a figure is refused rather
            than guessed at, and read back to them before it is written down.
          </p>
        </>
      )}

      {step.do === "finish" && (
        <div className="mt-3">
          <p className="rounded border border-rule bg-paper px-3.5 py-2.5 text-[13px]">
            {step.summary}
          </p>
          <form action={finishCall} className="mt-2">
            {hidden}
            <input type="hidden" name="callId" value={live.id} />
            <input type="hidden" name="status" value="completed" />
            <button className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
              {writePolicy(live.mode).candidateFields ? "Close and write it down" : "Close the dry run"}
            </button>
          </form>
        </div>
      )}

      {live.answers.length > 0 && (
        <dl className="mt-3 grid gap-1 border-t border-rule pt-3">
          {live.answers.map((a) => (
            <div key={a.field} className="flex flex-wrap items-baseline gap-2 text-[12px]">
              <dt className="w-[118px] shrink-0 text-ink-faint">{FIELD_LABEL[a.field]}</dt>
              <dd className="font-medium">{String(a.value)}</dd>
              <dd className="text-ink-faint">&ldquo;{a.heard}&rdquo;</dd>
            </div>
          ))}
        </dl>
      )}

      <form action={finishCall} className="mt-3 flex flex-wrap items-end gap-2 border-t border-rule pt-3">
        {hidden}
        <input type="hidden" name="callId" value={live.id} />
        <input type="hidden" name="status" value="failed" />
        <input
          name="failureReason"
          placeholder="No answer, wrong number, call back later…"
          className={`${input} w-[260px]`}
        />
        <button className="rounded border border-rule-strong px-3 py-1.5 text-[12.5px]">
          Did not get through
        </button>
      </form>
    </div>
  );
}
