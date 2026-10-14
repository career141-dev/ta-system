"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { changeWorkday } from "@/app/workday/actions";
import {
  completionBlockers,
  workdayDate,
  workdayTime,
  type WorkdayCheck,
  type WorkdayPayload,
  type WorkdayView,
} from "@/lib/workday";
import { HEADER_H } from "@/lib/chrome";

function useWorkday(detail: boolean, enabled = true) {
  const [data, setData] = useState<WorkdayPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch(`/api/workday${detail ? "?detail=1" : ""}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "Could not load workday checks. Retry before finishing work.",
        );
      setData(await response.json());
      setError("");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not load workday.",
      );
    }
  }, [detail, enabled]);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20000);
    const changed = () => {
      void load();
    };
    window.addEventListener("workday-changed", changed);
    window.addEventListener("focus", changed);
    return () => {
      clearInterval(poll);
      window.removeEventListener("workday-changed", changed);
      window.removeEventListener("focus", changed);
    };
  }, [load, enabled]);
  return { data, error, load };
}

const inputClass =
  "w-full rounded-lg border border-rule bg-surface p-2 text-sm";
const buttonClass =
  "rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40";

function WorkForm({
  children,
  op,
  fields = {},
}: {
  children: React.ReactNode;
  op: string;
  fields?: Record<string, string>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(false);
  return (
    <form
      className="space-y-3"
      action={(form) =>
        startTransition(async () => {
          const result = await changeWorkday(form);
          setMessage(result.message);
          setOk(result.ok);
          window.dispatchEvent(new Event("workday-changed"));
        })
      }
    >
      <input type="hidden" name="op" value={op} />
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <fieldset disabled={pending} className="space-y-3 disabled:opacity-60">
        {children}
      </fieldset>
      {pending && (
        <p className="text-sm" role="status">
          Saving…
        </p>
      )}
      {message && (
        <p
          className={`text-sm ${ok ? "text-brand" : "text-danger"}`}
          role="status"
        >
          {message}
        </p>
      )}
    </form>
  );
}

function JobPicker({ data, day }: { data: WorkdayPayload; day?: WorkdayView }) {
  const available = data.options.filter(
    (o) =>
      !day?.jobs.some((j) => j.jobId === o.id) &&
      !day?.requests.some((r) => r.jobId === o.id),
  );
  if (!available.length)
    return (
      <p className="text-sm text-ink-soft">
        No other assigned positions are available. Ask your TA Lead to check
        your assignments.
      </p>
    );
  return (
    <WorkForm
      op={day ? "addPosition" : "start"}
      fields={day ? { workdayId: day.id } : {}}
    >
      <label className="block text-sm">
        Assigned position
        <select required name="jobId" className={inputClass}>
          <option value="">Select a position</option>
          {available.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Work type
        <select name="workType" className={inputClass}>
          {["100%", "Add-on", "Follow-up"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <button className={buttonClass}>
        {!day
          ? "Start workday"
          : "Add position"}
      </button>
    </WorkForm>
  );
}

function Check({ check, dayId }: { check: WorkdayCheck; dayId: string }) {
  return (
    <li className="space-y-2 border-b border-rule py-3 text-sm">
      <Link
        className="font-medium underline decoration-rule underline-offset-4"
        href={check.href}
      >
        {check.label}
      </Link>
      {check.waiting ? (
        <p className="text-ink-soft">
          Waiting: {check.waiting.reason}
          <br />
          Next: {check.waiting.nextAction} · {workdayTime(check.waiting.dueAt)}
        </p>
      ) : (
        <>
          {check.kind === "cv_review" &&
            check.key.startsWith("review:") &&
            !check.label.startsWith("A new CV") && (
              <WorkForm
                op="markReviewed"
                fields={{ workdayId: dayId, applicationId: check.key.slice(7) }}
              >
                <button className="text-brand underline">
                  I reviewed this CV — record review
                </button>
              </WorkForm>
            )}
          {check.canCarry && (
            <details>
              <summary className="cursor-pointer text-brand">
                Record why this must carry forward
              </summary>
              <div className="mt-2">
                <WorkForm
                  op="carry"
                  fields={{
                    workdayId: dayId,
                    jobId: check.jobId,
                    key: check.key,
                  }}
                >
                  <label className="block">
                    Reason
                    <textarea
                      required
                      name="reason"
                      maxLength={1000}
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    Next action
                    <input
                      required
                      name="nextAction"
                      maxLength={1000}
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    Follow-up time (Sri Lanka)
                    <input
                      required
                      type="datetime-local"
                      name="dueAt"
                      className={inputClass}
                    />
                  </label>
                  <button className={buttonClass}>Save next action</button>
                </WorkForm>
              </div>
            </details>
          )}
        </>
      )}
    </li>
  );
}

function DailyReview({
  day,
  canFinish = false,
  lead = false,
}: {
  day: WorkdayView;
  canFinish?: boolean;
  lead?: boolean;
}) {
  const blockers = completionBlockers(day.jobs);
  return (
    <section className="space-y-5 rounded-xl border border-rule bg-surface p-5">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold">
          {day.name} · {day.date}
        </h2>
        <p className="text-sm">
          Started {workdayTime(day.startedAt)} ·{" "}
          {day.finishedAt
            ? `Finished ${workdayTime(day.finishedAt)}`
            : "Working"}
        </p>
      </div>
      {day.jobs.map((job) => (
        <section key={job.jobId} className="rounded-lg border border-rule p-4">
          <div className="flex flex-wrap justify-between gap-2">
            <Link
              className="font-semibold text-brand"
              href={`/openings/${job.jobId}`}
            >
              {job.title}
            </Link>
            <span className="text-sm">{job.workType}</span>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            {job.activity.cvReviews} CV reviews · {job.activity.profilesAdded}{" "}
            LinkedIn profiles added · {job.activity.profilesWorked} profiles
            worked · {job.activity.sent} candidates submitted
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            JD {job.activity.jdApproved ? "approved" : "awaiting approval"} ·
            LinkedIn post{" "}
            {job.activity.postConnected ? "connected" : "not connected"} ·{" "}
            {job.activity.researchActions} research changes and{" "}
            {job.activity.benchmarkActions} benchmark changes recorded during
            this workday.
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            <Link
              href={`/openings/${job.jobId}/hh/research`}
              className="underline"
            >
              Research
            </Link>
            :{" "}
            {job.activity.researchAt
              ? workdayTime(job.activity.researchAt)
              : "not recorded"}{" "}
            · {job.activity.benchmarks} benchmarks (
            {job.activity.benchmarksAdded} added during workday).{" "}
            {job.activity.emailAt
              ? `Email accepted for sending ${workdayTime(job.activity.emailAt)}.`
              : "End-of-day email not sent."}
          </p>
          <p className="mt-3 text-sm font-medium">
            Shortlisted today and candidates still in progress
          </p>
          {job.shortlist.length ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="py-2">Candidate</th>
                    <th>Source</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.shortlist.map((c) => (
                    <tr key={c.id} className="border-t border-rule">
                      <td className="py-2">{c.name}</td>
                      <td>{c.source}</td>
                      <td>
                        {c.sent
                          ? "Already sent"
                          : c.stage === "director_review"
                            ? "Ready to send"
                            : c.stage.replaceAll("_", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">
              No candidates shortlisted during this workday.
            </p>
          )}
          <Link
            href={`/openings/${job.jobId}/eod`}
            className="mt-3 inline-block text-sm text-brand underline"
          >
            Review this job's end-of-day email
          </Link>
          {job.checks.length > 0 && (
            <ul className="mt-3">
              {job.checks.map((check) =>
                !canFinish ? (
                  <li key={check.key} className="py-2 text-sm">
                    {check.label}
                    {check.waiting
                      ? ` · Carried forward: ${check.waiting.nextAction} (${workdayTime(check.waiting.dueAt)})`
                      : ""}
                  </li>
                ) : (
                  <Check key={check.key} check={check} dayId={day.id} />
                ),
              )}
            </ul>
          )}
          {lead &&
            day.finishedAt === null &&
            job.checks
              .filter(
                (c) => c.kind === "cv_review" && c.key.startsWith("review:"),
              )
              .map((check) => (
                <WorkForm
                  key={check.key}
                  op="markReviewed"
                  fields={{
                    workdayId: day.id,
                    applicationId: check.key.slice(7),
                  }}
                >
                  <button className="text-sm text-brand underline">
                    I reviewed this CV as TA Lead — record review
                  </button>
                </WorkForm>
              ))}
          {lead &&
            day.finishedAt === null &&
            job.checks
              .filter((c) => c.key.startsWith("mail:"))
              .map((check) => (
                <details key={check.key} className="mt-3 text-sm">
                  <summary className="cursor-pointer text-brand">
                    Reconcile this email after checking the mailbox
                  </summary>
                  <div className="mt-3">
                    <WorkForm
                      op="reconcileMail"
                      fields={{ id: check.key.slice(5) }}
                    >
                      <label className="block">
                        Verification details / message reference
                        <textarea
                          required
                          name="reason"
                          maxLength={1000}
                          className={inputClass}
                        />
                      </label>
                      <label className="block">
                        <input
                          required
                          type="checkbox"
                          name="verified"
                          value="yes"
                        />{" "}
                        I checked the sending mailbox and verified the result.
                      </label>
                      <button
                        name="accepted"
                        value="yes"
                        className={buttonClass}
                      >
                        Confirm accepted and recover record
                      </button>{" "}
                      <button
                        name="accepted"
                        value="no"
                        className="rounded-lg border border-rule p-2"
                      >
                        Confirm not sent — allow retry
                      </button>
                    </WorkForm>
                  </div>
                </details>
              ))}
        </section>
      ))}
      {day.requests.map((request) => (
        <p className="text-sm" key={request.id}>
          {request.title}: {request.status}
          {request.reason ? ` — ${request.reason}` : ""}
        </p>
      ))}
      {canFinish && (
        <WorkForm op="finish" fields={{ workdayId: day.id }}>
          <p className="text-sm">
            {blockers.length
              ? `${blockers.length} required steps still need action.`
              : "All required checks are complete. Waiting items will carry forward."}
          </p>
          <button className={buttonClass}>Finish workday</button>
          <p className="text-xs text-ink-soft">
            Checks run again when you press Finish. The finish time is recorded
            only if they pass.
          </p>
        </WorkForm>
      )}
    </section>
  );
}

export function WorkdayDashboard() {
  const { data, error, load } = useWorkday(true);
  const finishedToday = data?.lastFinishedDate === workdayDate(Date.now());
  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-danger">
          {error}{" "}
          <button className="underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading workday…</p>}
      {data?.canWork && (
        <>
          {data.active ? (
            <>
              <DailyReview day={data.active} canFinish />
              <details className="rounded-xl border border-rule p-5">
                <summary className="cursor-pointer font-medium">
                  Add another position
                </summary>
                <div className="mt-4">
                  <JobPicker data={data} day={data.active} />
                </div>
              </details>
            </>
          ) : (
            <section className="rounded-xl border border-rule bg-surface p-5">
              <h2 className="mb-3 font-semibold">
                {finishedToday
                  ? "Today's workday is finished"
                  : "Start workday"}
              </h2>
              {finishedToday ? (
                <p className="text-sm">
                  Finished {workdayTime(data.lastFinishedAt)}. Your TA Lead can
                  see this time.
                </p>
              ) : (
                <JobPicker data={data} />
              )}
            </section>
          )}
          {data.history.length > 0 && (
            <details>
              <summary className="cursor-pointer font-semibold">
                Previous workdays
              </summary>
              <div className="mt-4 space-y-4">
                {data.history.map((day) => (
                  <DailyReview key={day.id} day={day} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {data?.canLead && (
        <>
          <h2 className="text-lg font-semibold">Team workdays</h2>
          <p className="text-sm text-ink-soft">
            Start and finish times update every 20 seconds. Records show elapsed
            workday time; breaks are not measured.
          </p>
          {!data.team.length && (
            <p className="text-sm">
              No workdays have been recorded for your jobs yet.
            </p>
          )}
          {data.team.map((day) => (
            <div key={day.id} className="space-y-3">
              <DailyReview day={day} lead />
              {day.finishedAt === null &&
                day.requests
                  .filter((r) => r.status === "pending")
                  .map((request) => (
                    <section
                      key={request.id}
                      className="rounded-xl border border-rule p-5"
                    >
                      <h3 className="mb-3 font-medium">
                        {day.name}: approval to work on {request.title}
                      </h3>
                      <WorkForm op="decide" fields={{ requestId: request.id }}>
                        <label className="block text-sm">
                          Decision reason
                          <input
                            required
                            name="reason"
                            maxLength={1000}
                            className={inputClass}
                          />
                        </label>
                        <button
                          className={buttonClass}
                          name="approve"
                          value="yes"
                        >
                          Approve
                        </button>{" "}
                        <button
                          className="rounded-lg border border-rule px-4 py-2 text-sm"
                          name="approve"
                          value="no"
                        >
                          Decline
                        </button>
                      </WorkForm>
                    </section>
                  ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function WorkdayRail() {
  const path = usePathname();
  const { data, error, load } = useWorkday(false, path !== "/workday");
  const [open, setOpen] = useState(false);
  if (path === "/workday") return null;
  const day = data?.active;
  const finishedToday = data?.lastFinishedDate === workdayDate(Date.now());
  return (
    <>
      <button
        className="fixed right-3 z-30 rounded-lg border border-rule bg-surface p-2 text-sm shadow-sm xl:hidden"
        style={{ top: `calc(${HEADER_H} + 10px)` }}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Today's checks {day ? completionBlockers(day.jobs).length : ""}
      </button>
      <aside
        aria-label="Today's workday checks"
        className={`${open ? "block" : "hidden"} fixed right-0 z-20 w-80 overflow-y-auto border-l border-rule bg-surface p-4 shadow-sm xl:block`}
        style={{ top: HEADER_H, bottom: 0 }}
      >
        <h2 className="font-semibold">Today's checks</h2>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}{" "}
            <button className="underline" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
        {!data && !error && <p className="mt-3 text-sm">Loading…</p>}
        {day ? (
          <>
            <p className="mt-2 text-xs text-ink-soft">
              Started {workdayTime(day.startedAt)}
            </p>
            <Link
              href="/workday"
              className="my-3 inline-block rounded-lg bg-brand px-3 py-2 text-sm text-white"
            >
              Review and finish workday
            </Link>
            {day.jobs.map((job) => (
              <section key={job.jobId} className="mt-4">
                <h3 className="text-sm font-semibold">
                  {job.title} · {job.workType}
                </h3>
                <ul>
                  {job.checks.map((check) => (
                    <Check key={check.key} check={check} dayId={day.id} />
                  ))}
                </ul>
                {!job.checks.length && (
                  <p className="mt-2 text-sm text-brand">
                    Required checks complete.
                  </p>
                )}
              </section>
            ))}
          </>
        ) : (
          data && (
            <>
              <p className="my-3 text-sm text-ink-soft">
                {finishedToday
                  ? `Workday finished ${workdayTime(data.lastFinishedAt)}.`
                  : "Your workday has not started. Opening the website does not start the clock."}
              </p>
              <Link className={buttonClass} href="/workday">
                {finishedToday ? "View workday" : "Start workday"}
              </Link>
            </>
          )
        )}
      </aside>
    </>
  );
}

export function WorkdayWorkspace({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className={path === "/workday" ? "" : "xl:pr-80"}>
      {children}
      <WorkdayRail />
    </div>
  );
}
