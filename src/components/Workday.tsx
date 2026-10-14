"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useId, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
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
import { RESEARCH_FIELDS, RESEARCH_LABELS } from "@/lib/workdayRequirements";
import { validateResearchLink } from "@/lib/eod-format";

function useWorkday(detail: boolean, enabled = true, query = "") {
  const [data, setData] = useState<WorkdayPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch(`/api/workday?detail=${detail ? "1" : "0"}${query}`, {
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
  }, [detail, enabled, query]);
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

function useSavedChoice(key: string, initial = "") {
  const [value, setValue] = useState(initial);
  useEffect(() => { const saved = localStorage.getItem(key); if (saved !== null) setValue(saved); }, [key]);
  const save = (next: string) => { setValue(next); localStorage.setItem(key, next); };
  return [value, save] as const;
}

function SavedDetails({ id, title, children }: { id: string; title: React.ReactNode; children: React.ReactNode }) {
  const [open, save] = useSavedChoice(`workday-open:${id}`, "yes");
  return <details open={open === "yes"} onToggle={e => { const value = e.currentTarget.open ? "yes" : "no"; if (value !== open) save(value); }} className="min-w-0 rounded-lg border border-rule p-3">
    <summary className="cursor-pointer text-sm font-semibold">{title}</summary><div className="mt-3 space-y-3">{children}</div>
  </details>;
}

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
  const [selected, select] = useSavedChoice(`workday-job:${day?.id ?? "start"}`);
  const [addon, setAddon] = useState(false);
  const available = data.options.filter(
    (o) =>
      !day?.jobs.some((j) => j.jobId === o.id) &&
      !day?.requests.some((r) => r.jobId === o.id),
  );
  const chosen = available.find(o => o.id === selected);
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
        <select required name="jobId" className={inputClass} value={chosen?.id ?? ""} onChange={e => { select(e.target.value); setAddon(false); }}>
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
        <select name="workType" className={inputClass} value={addon ? "Add-on" : chosen?.workType ?? "100%"} onChange={e => setAddon(e.target.value === "Add-on")}>
          {(chosen?.workType === "Follow-up" ? ["Follow-up", "Add-on"] : ["100%"]).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      {!day && data.options.some(o => o.carry) && <p className="text-xs text-ink-soft">Follow-up jobs carried forward: {data.options.filter(o => o.carry && o.id !== chosen?.id).map(o => o.title).join(", ")}</p>}
      {!day && chosen?.preview && <ul className="text-xs text-ink-soft">{chosen.preview.checks.filter(c => !addon || !["linkedin_post", "research", "suggestions", "excel_profiles"].some(k => c.key.startsWith(k + ":"))).map(c => <li key={c.key} className="py-1">{c.status === "complete" ? "✓" : "○"} {c.label}: {c.progress}</li>)}</ul>}
      <button className={buttonClass}>
        {!day
          ? "Start workday"
          : "Add position"}
      </button>
    </WorkForm>
  );
}

function Check({ check, dayId, readOnly = false }: { check: WorkdayCheck; dayId: string; readOnly?: boolean }) {
  return (
    <li className="space-y-2 border-b border-rule py-3 text-sm">
      <Link
        className="font-medium underline decoration-rule underline-offset-4"
        href={check.href}
      >
        {check.status === "complete" ? "✓ " : check.waiting ? "◷ " : "○ "}{check.label}
      </Link>
      {check.progress && <p className="break-words text-xs text-ink-soft">{check.progress}</p>}
      {check.status === "complete" && <p className="text-xs text-brand">{check.completedAt ? `Completed ${workdayTime(check.completedAt)}` : "Completion time not recorded"}{check.completedBy ? ` · ${check.completedBy}` : ""}</p>}
      {!!check.events?.length && <details><summary className="cursor-pointer text-xs text-ink-soft">Task history</summary><ul className="mt-2 space-y-1 text-xs">{check.events.map((event, i) => <li key={i}>{event.observed ? "Existing completion recorded" : event.status === "incomplete" ? i ? "Reopened" : "Incomplete" : event.status === "complete" ? "Completed" : "Waiting"} · {workdayTime(event.at)}{event.by ? ` · ${event.by}` : ""}</li>)}</ul></details>}
      {check.waiting ? (
        <p className="text-ink-soft">
          Waiting: {check.waiting.reason}
          <br />
          Next: {check.waiting.nextAction} · {workdayTime(check.waiting.dueAt)}
        </p>
      ) : !readOnly && check.status !== "complete" ? (
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
          {check.key.startsWith("director_candidate:") && <WorkForm op="saveCheck" fields={{ jobId: check.jobId, kind: "noCandidates" }}>
            <label className="block text-xs">Why no suitable candidates were found<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save explanation</button>
          </WorkForm>}
          {check.key.startsWith("research:") && <ResearchConfirmation jobId={check.jobId} />}
          {check.key.startsWith("jd_review:") && <WorkForm op="saveCheck" fields={{ jobId: check.jobId, kind: "jd" }}><p className="text-xs text-ink-soft">Read the approved job description before confirming.</p><button className={buttonClass}>I reviewed the job description</button></WorkForm>}
          {check.needsEmptySuggestionsReason && <WorkForm op="saveCheck" fields={{ jobId: check.jobId, kind: "emptySuggestions" }}>
            <label className="block text-xs">Why no profiles were found<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save explanation</button>
          </WorkForm>}
          {check.key.startsWith("chatgpt:") && <ChatgptConfirmation jobId={check.jobId} />}
        </>
      ) : null}
    </li>
  );
}

export function ResearchConfirmation({ jobId }: { jobId: string }) {
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "research" }}>
    <details><summary className="cursor-pointer text-xs text-brand">Unavailable research fields</summary><p className="my-2 text-xs text-ink-soft">Fill fields in Research. For anything that cannot be sourced, explain why here.</p>{RESEARCH_FIELDS.map(key => <label key={key} className="mb-2 block text-xs">{RESEARCH_LABELS[key]}<input name={`unavailable:${key}`} maxLength={1000} className={inputClass} /></label>)}</details>
    <button className={buttonClass}>I reviewed the research</button>
  </WorkForm>;
}

export function ChatgptConfirmation({ jobId, link = "", confirmed = false }: { jobId: string; link?: string; confirmed?: boolean }) {
  const [typedLink, setTypedLink] = useState("");
  const [opened, setOpened] = useState(false);
  const helpId = useId();
  const checked = validateResearchLink(link || typedLink);
  const ready = checked.ok && (link ? confirmed : opened);
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "chatgpt", ...(link ? { link } : {}), ...(confirmed ? { confirmed: "on" } : {}) }}>
    {!link && <>
      <p className="text-xs text-ink-soft">In ChatGPT, choose Share, then Create link or Copy link. Paste the shared link here; copying the browser address gives your private chat link.</p>
      <label className="block text-xs">ChatGPT share link<input required name="link" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://chatgpt.com/share/…" value={typedLink} onChange={e => {
        setTypedLink(e.target.value);
        // Confirmation belongs to this exact link, as on the email composer.
        setOpened(false);
      }} aria-invalid={!!typedLink.trim() && !checked.ok} aria-describedby={helpId} className={inputClass} /></label>
      <p id={helpId} aria-live="polite" className="break-words text-xs text-ink-soft">
        {checked.ok ? "Share link accepted. Open it in a private window, then confirm below." : typedLink.trim() ? checked.reason : "Use a link beginning with https://chatgpt.com/share/."}
      </p>
      <label className="block text-xs"><input required type="checkbox" name="confirmed" checked={opened} disabled={!checked.ok} onChange={e => setOpened(e.target.checked)} /> I opened this link in a private window and it contains no candidate details.</label>
    </>}
    <button disabled={!ready} className={buttonClass}>Save research link</button>
  </WorkForm>;
}

export function NoCandidateReason({ jobId }: { jobId: string }) {
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "noCandidates" }}><label className="block text-xs">Why no suitable candidates were found<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save explanation</button></WorkForm>;
}

export function EmptySuggestionsReason({ jobId }: { jobId: string }) {
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "emptySuggestions" }}><label className="block text-xs">Why this search found no profiles<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save empty-search explanation</button></WorkForm>;
}

export function EodJobChecks({ jobId, linkConfirmed, revised, onBlocked }: { jobId: string; linkConfirmed: boolean; revised: boolean; onBlocked: (blocked: boolean) => void }) {
  const { data, error } = useWorkday(false);
  const job = data?.active?.jobs.find(j => j.jobId === jobId);
  const blockers = job?.checks.filter(c => c.status !== "complete" && !c.waiting && c.blocksEmail &&
    !(linkConfirmed && c.key.startsWith("chatgpt:")) && !(revised && (c.key.startsWith("director_candidate:") || c.kind === "handoff"))) ?? [];
  const blocked = !!error || !data || (data.canWork && (!job || blockers.length > 0));
  useEffect(() => { onBlocked(blocked); }, [blocked, onBlocked]);
  if (data && !data.canWork) return null;
  return <section className="rounded-lg border border-rule p-4 text-sm"><h3 className="font-medium">Today's Checks</h3>{error ? <p>{error}</p> : !data ? <p>Loading checks…</p> : !job ? <p>Start work on this opening in the sidebar before sending.</p> : blockers.length ? <ul className="mt-2 space-y-1">{blockers.map(c => <li key={c.key}><Link href={c.href} className="text-brand underline">{c.label}</Link>: {c.progress ?? "needs action"}</li>)}</ul> : <p className="text-brand">Required checks complete.</p>}{!revised && blockers.some(c => c.key.startsWith("director_candidate:")) && <div className="mt-3"><NoCandidateReason jobId={jobId} /></div>}</section>;
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
    <section className="space-y-3">
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
        <SavedDetails key={job.jobId} id={`${day.id}:${job.jobId}`} title={<>{job.title} · {job.workType} · {job.checks.filter(c => c.status === "complete").length}/{job.checks.length} complete</>}>
          <div className="flex flex-wrap justify-between gap-2">
            <Link
              className="font-semibold text-brand"
              href={`/openings/${job.jobId}`}
            >
              {job.title}
            </Link>
            <span className="text-sm">{job.workType}</span>
          </div>
          {canFinish && job.workType !== "100%" && <WorkForm op="setWorkType" fields={{ workdayId: day.id, jobId: job.jobId }}><label className="block text-xs">Work type<select name="workType" defaultValue={job.workType} className={inputClass}><option>Follow-up</option><option>Add-on</option></select></label><button className={buttonClass}>Set work type</button></WorkForm>}
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
            <ul className="mt-2 divide-y divide-rule text-xs">{job.shortlist.map(c => <li key={c.id} className="py-2"><p className="font-medium">{c.name}</p><p>{c.source} · {c.sent ? "Already sent" : c.stage === "director_review" ? "Ready to send" : c.stage.replaceAll("_", " ")}</p></li>)}</ul>
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
              {job.checks.map((check) => <Check key={check.key} check={check} dayId={day.id} readOnly={!canFinish} />)}
            </ul>
          )}
          {lead &&
            day.finishedAt === null &&
            job.checks
              .filter(
                (c) => c.status !== "complete" && c.kind === "cv_review" && c.key.startsWith("review:"),
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
        </SavedDetails>
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
          <button className={buttonClass} disabled={blockers.length > 0}>Finish workday</button>
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
  const [date, setDate] = useSavedChoice("workday-date");
  const [ta, setTa] = useSavedChoice("workday-ta");
  const [jobFilter, setJobFilter] = useSavedChoice("workday-filter-job");
  const [status, setStatus] = useSavedChoice("workday-filter-status");
  const [cursor, setCursor] = useState("");
  const { data, error, load } = useWorkday(true, true, `&date=${encodeURIComponent(date)}&cursor=${encodeURIComponent(cursor)}`);
  const finishedToday = data?.lastFinishedDate === workdayDate(Date.now());
  const team = (data?.team ?? []).filter(day => (!ta || day.userId === ta) && (!date || day.date === date)).map(day => ({ ...day, jobs: day.jobs.filter(job => !jobFilter || job.jobId === jobFilter).map(job => ({ ...job, checks: job.checks.filter(c => !status || (c.waiting ? "waiting" : c.status ?? "incomplete") === status) })) })).filter(day => day.jobs.length > 0 || day.requests.length > 0);
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
              <DailyReview day={data.active} canFinish={!error} />
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
                <><p className="text-sm">
                  Finished {workdayTime(data.lastFinishedAt)}. Your TA Lead can
                  see this time.
                </p>{data.history.find(d => d.date === workdayDate(Date.now())) && <DailyReview day={data.history.find(d => d.date === workdayDate(Date.now()))!} />}</>
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
                <label className="block text-xs">Previous day<input type="date" value={date} onChange={e => { setDate(e.target.value); setCursor(""); }} className={inputClass} /></label>
                {data.history.filter(day => !date || day.date === date).map((day) => (
                  <DailyReview key={day.id} day={day} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {data?.canLead && (
        <>
          <h2 className="text-lg font-semibold">Team checks</h2>
          <label className="block text-xs">Day<input type="date" value={date} onChange={e => { setDate(e.target.value); setCursor(""); }} className={inputClass} /></label>
          <label className="block text-xs">TA<select value={ta} onChange={e => setTa(e.target.value)} className={inputClass}><option value="">All TAs</option>{[...new Map(data.team.map(d => [d.userId, d.name])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="block text-xs">Job<select value={jobFilter} onChange={e => setJobFilter(e.target.value)} className={inputClass}><option value="">All jobs</option>{[...new Map(data.team.flatMap(d => d.jobs.map(j => [j.jobId, j.title] as const))).entries()].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label className="block text-xs">Task status<select value={status} onChange={e => setStatus(e.target.value)} className={inputClass}><option value="">All tasks</option><option value="incomplete">Incomplete</option><option value="complete">Complete</option><option value="waiting">Waiting</option></select></label>
          <p className="text-sm text-ink-soft">
            Start and finish times update every 20 seconds. Records show elapsed
            workday time; breaks are not measured.
          </p>
          {!team.length && (
            <p className="text-sm">
              No workdays have been recorded for your jobs yet.
            </p>
          )}
          {team.map((day) => (
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
          <div className="flex gap-3 text-xs">{cursor && <button className="text-brand underline" onClick={() => setCursor("")}>Latest records</button>}{data.nextCursor && <button className="text-brand underline" onClick={() => setCursor(data.nextCursor!)}>Older records</button>}</div>
        </>
      )}
    </div>
  );
}

export function WorkdayRail() {
  const [open, setOpen] = useState(false);
  const params = useSearchParams();
  const requestedOpen = params.get("checks") === "open";
  useEffect(() => { if (requestedOpen) setOpen(true); }, [requestedOpen]);
  return <>
    <button className={`${open ? "hidden" : ""} fixed right-3 z-30 rounded-lg border border-rule bg-surface p-2 text-sm shadow-sm xl:hidden`} style={{ top: HEADER_H + 10 }} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="workday-rail">Today's checks</button>
    <aside id="workday-rail" aria-label="Today's workday checks" className={`${open ? "block" : "hidden"} fixed right-0 z-20 w-full max-w-96 overflow-y-auto border-l border-rule bg-surface p-3 pb-24 shadow-sm xl:block`} style={{ top: HEADER_H, bottom: 0 }}>
      <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Today's Checks</h2><button onClick={() => setOpen(false)} className="text-sm text-brand xl:hidden">Close</button></div>
      <WorkdayDashboard />
    </aside>
  </>;
}

export function WorkdayWorkspace({ children }: { children: React.ReactNode }) {
  return <div className="xl:pr-96">{children}<Suspense fallback={null}><WorkdayRail /></Suspense></div>;
}
