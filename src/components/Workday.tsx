"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { changeWorkday } from "@/app/workday/actions";
import {
  completionBlockers,
  canExcuseCheck,
  emailBlockers,
  confirmedResearchLink,
  workdayDate,
  workdayTime,
  type WorkdayCheck,
  type WorkdayPayload,
  type WorkdayView,
  type WorkType,
} from "@/lib/workday";
import { HEADER_H } from "@/lib/chrome";
import { RESEARCH_FIELDS, RESEARCH_LABELS } from "@/lib/workdayRequirements";
import { validateResearchLink } from "@/lib/eod-format";
import { sidebarChecks } from "@/lib/workdaySidebar";
import { canReviewWorkdays } from "@/lib/workdayRoles";
import { useChatgptResearch } from "./useChatgptResearch";

function useWorkday(detail: boolean, enabled = true, query = "") {
  const [data, setData] = useState<WorkdayPayload | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    // A poll started before Save must not overwrite the refreshed checks.
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    try {
      const response = await fetch(`/api/workday?detail=${detail ? "1" : "0"}${query}`, {
        cache: "no-store",
        signal: current.signal,
      });
      if (!response.ok)
        throw new Error(
          "Could not load workday checks. Retry before finishing work.",
        );
      const next: WorkdayPayload = await response.json();
      if (current.signal.aborted || request.current !== current) return;
      setData(next);
      setError("");
    } catch (error) {
      if (current.signal.aborted || request.current !== current) return;
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
      request.current?.abort();
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

function SavedDetails({ id, title, children, initiallyOpen = true }: { id: string; title: React.ReactNode; children: React.ReactNode; initiallyOpen?: boolean }) {
  const [open, save] = useSavedChoice(`workday-open:${id}`, initiallyOpen ? "yes" : "no");
  const params = useSearchParams();
  const requestedJob = `${params.get("checkDay")}:${params.get("checkJob")}`;
  const requestedTask = params.get("checkTask");
  useEffect(() => {
    if (id === requestedJob || id === `team:${params.get("checkDay")}`) save("yes");
    // Open the targeted job once, without overriding later user toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, requestedJob, requestedTask]);
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
  const [mode, setMode] = useState<WorkType | null>(null);
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
        <select required name="jobId" className={inputClass} value={chosen?.id ?? ""} onChange={e => { select(e.target.value); setMode(null); }}>
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
        <select name="workType" className={inputClass} value={mode ?? chosen?.workType ?? "100%"} onChange={e => setMode(e.target.value as WorkType)}>
          {(["100%", "Follow-up", "Add-on"] as WorkType[]).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <p className="text-xs text-ink-soft">
        New positions start at 100%. Choose Follow-up or Add-on for historical or returning work.
      </p>
      {!day && data.options.some(o => o.carry) && <p className="text-xs text-ink-soft">Follow-up jobs carried forward: {data.options.filter(o => o.carry && o.id !== chosen?.id).map(o => o.title).join(", ")}</p>}
      {!day && (mode ?? chosen?.workType) === "100%" && chosen?.preview && <ul className="text-xs text-ink-soft">{chosen.preview.checks.map(c => <li key={c.key} className="py-1">{c.status === "complete" ? "✓" : "○"} {c.label}: {c.progress}</li>)}</ul>}
      <button className={buttonClass}>
        {!day
          ? "Start workday"
          : "Add position"}
      </button>
    </WorkForm>
  );
}

function Check({ check, dayId, readOnly = false }: { check: WorkdayCheck; dayId: string; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const target = `task-${dayId}-${check.key}`;
  const params = useSearchParams();
  const requestedTask = `${params.get("checkDay")}:${params.get("checkTask")}`;
  useEffect(() => {
    if (requestedTask === `${dayId}:${check.key}`) {
      setOpen(true);
      document.getElementById(target)?.scrollIntoView({ block: "nearest" });
    }
  }, [dayId, check.key, target, requestedTask]);
  const complete = check.status === "complete";
  const status = complete ? "Completed" : check.exception ? "Reason submitted" : check.waiting ? "Waiting" : "To do";
  return (
    <li id={target} className="border-b border-rule py-2 text-sm">
      <details open={open} onToggle={e => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer rounded-md py-2 font-medium focus-visible:outline-2 focus-visible:outline-brand">
          <span className={complete ? "text-green-700 dark:text-green-400" : check.exception ? "text-amber-700 dark:text-amber-400" : "text-ink-soft"}>
            <span aria-hidden="true">{complete ? "✓" : check.exception ? "!" : check.waiting ? "◷" : "○"}</span>{" "}{check.label}
            <span className="ml-2 text-xs font-normal">{status}</span>
          </span>
        </summary>
        <div className="space-y-3 pb-2 pl-3">
      <Link
        className="font-medium underline decoration-rule underline-offset-4"
        href={check.href}
      >
        Open task page
      </Link>
      {check.progress && <p className="break-words text-xs text-ink-soft">{check.progress}</p>}
      {check.key.startsWith("candidate_progress:") && <p className="text-xs text-ink-soft">This progress check does not block sending your end-of-day email.</p>}
      {check.status === "complete" && <p className="text-xs text-brand">{check.completedAt ? `Completed ${workdayTime(check.completedAt)}` : "Completion time not recorded"}{check.completedBy ? ` · ${check.completedBy}` : ""}</p>}
      {!!check.events?.length && <details><summary className="cursor-pointer text-xs text-ink-soft">Task history</summary><ul className="mt-2 space-y-1 text-xs">{check.events.map((event, i) => <li key={i}>{event.observed ? "Existing completion recorded" : event.status === "incomplete" ? i ? "Reopened" : "Incomplete" : event.status === "complete" ? "Completed" : event.status === "reason_submitted" ? "Reason submitted" : event.status === "reason_withdrawn" ? "Reason withdrawn" : "Waiting"} · {workdayTime(event.at)}{event.by ? ` · ${event.by}` : ""}{event.evidence && event.status.startsWith("reason_") ? <p className="break-words text-ink-soft">{event.evidence}</p> : null}</li>)}</ul></details>}
      {check.exception && <p className="break-words text-xs text-amber-700 dark:text-amber-400">Reason submitted: {check.exception.reason}<br />{workdayTime(check.exception.at)} · {check.exception.by}</p>}
      {!readOnly && canExcuseCheck(check) && !complete && <details>
        <summary className="cursor-pointer text-xs text-brand">{check.exception ? "Edit reason" : "Couldn’t complete this task"}</summary>
        <p className="my-2 text-xs text-ink-soft">This excuses this task for today. Your TA lead and admins will be informed.</p>
        <WorkForm op="taskException" fields={{ workdayId: dayId, jobId: check.jobId, key: check.key }}>
          <label className="block text-xs">Reason<textarea key={check.exception?.at ?? "new"} required name="reason" maxLength={1000} defaultValue={check.exception?.reason ?? ""} className={inputClass} /></label>
          <button className={buttonClass}>{check.exception ? "Update reason" : "Submit reason"}</button>
        </WorkForm>
      </details>}
      {!readOnly && check.exception && <WorkForm op="taskException" fields={{ workdayId: dayId, jobId: check.jobId, key: check.key, withdraw: "yes" }}><button className="text-xs text-brand underline">Withdraw reason</button></WorkForm>}
      {!readOnly && check.key.startsWith("chatgpt:") && <ChatgptConfirmation jobId={check.jobId} link={check.status === "complete" ? check.evidence : undefined} />}
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
          {check.key.startsWith("jd_review:") && <WorkForm op="saveCheck" fields={{ jobId: check.jobId, kind: "jd" }}><p className="text-xs text-ink-soft">Read the approved job description before confirming.</p><button className={buttonClass}>I reviewed the job description</button></WorkForm>}
          {check.needsEmptySuggestionsReason && <WorkForm op="saveCheck" fields={{ jobId: check.jobId, kind: "emptySuggestions" }}>
            <label className="block text-xs">Why no profiles were found<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save explanation</button>
          </WorkForm>}

        </>
      ) : null}
        </div>
      </details>
    </li>
  );
}

export function ResearchConfirmation({ jobId }: { jobId: string }) {
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "research" }}>
    <details><summary className="cursor-pointer text-xs text-brand">Unavailable research fields</summary><p className="my-2 text-xs text-ink-soft">Fill fields in Research. For anything that cannot be sourced, explain why here.</p>{RESEARCH_FIELDS.map(key => <label key={key} className="mb-2 block text-xs">{RESEARCH_LABELS[key]}<input name={`unavailable:${key}`} maxLength={1000} className={inputClass} /></label>)}</details>
    <button className={buttonClass}>I reviewed the research</button>
  </WorkForm>;
}

export function ChatgptConfirmation({ jobId, link = "" }: { jobId: string; link?: string }) {
  const research = useChatgptResearch(jobId);
  const helpId = useId();
  const checked = validateResearchLink(research.link);
  useEffect(() => { if (link) research.adoptSaved(link); }, [link, research.adoptSaved]);
  return <div className="space-y-3">
    <p className="text-xs text-ink-soft">In ChatGPT, choose Share, then Create link or Copy link. Paste the shared link here or in the EOD email. Confirming saves it in both places.</p>
    <label className="block text-xs">ChatGPT share link<input name="sidebarChatgptLink" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://chatgpt.com/share/…" value={research.link} disabled={research.saving} onChange={e => research.edit(e.target.value)} aria-invalid={!!research.link.trim() && !checked.ok} aria-describedby={helpId} className={inputClass} /></label>
    <p id={helpId} className="break-words text-xs text-ink-soft">{checked.ok ? "Open the share link in a private window, then confirm below." : research.link.trim() ? checked.reason : "Use a link beginning with https://chatgpt.com/share/."}</p>
    <label className="block text-xs"><input type="checkbox" checked={research.confirmed || research.saving} disabled={research.saving || !checked.ok} onChange={e => research.confirm(e.target.checked)} /> I opened this link in a private window and it contains no candidate details.</label>
    <p className={`text-xs ${research.confirmed ? "text-brand" : "text-ink-soft"}`} role="status">{research.message}</p>
  </div>;
}

export function NoCandidateReason({ jobId }: { jobId: string }) {
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "noCandidates" }}><label className="block text-xs">Why no suitable candidates were found<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save explanation</button></WorkForm>;
}

export function EmptySuggestionsReason({ jobId }: { jobId: string }) {
  return <WorkForm op="saveCheck" fields={{ jobId, kind: "emptySuggestions" }}><label className="block text-xs">Why this search found no profiles<textarea required name="reason" maxLength={1000} className={inputClass} /></label><button className={buttonClass}>Save empty-search explanation</button></WorkForm>;
}

export function EodJobChecks({ jobId, linkConfirmed, revised, onBlocked, onResearchSaved, onResearchExcused, extraReasons = [] }: { jobId: string; linkConfirmed: boolean; revised: boolean; onBlocked: (blocked: boolean) => void; onResearchSaved?: (link: string) => void; onResearchExcused?: (excused: boolean) => void; extraReasons?: { key: string; message: string }[] }) {
  const { data, error } = useWorkday(false);
  const job = data?.active?.jobs.find(j => j.jobId === jobId);
  const savedLink = confirmedResearchLink(job?.eodChecks ?? job?.checks ?? []);
  const excused = !!job?.eodChecks?.find(c => c.key.startsWith("chatgpt:"))?.exception;
  useEffect(() => { onResearchExcused?.(!error && excused); }, [error, excused, onResearchExcused]);
  useEffect(() => { if (savedLink) onResearchSaved?.(savedLink); }, [savedLink, onResearchSaved]);
  const blockers = job ? emailBlockers([job]).filter(c => !(linkConfirmed && c.key.startsWith("chatgpt:"))) : [];
  const blocked = !!error || !data || (data.canWork && (!job || blockers.length > 0));
  const additionalReasons = extraReasons.filter(reason => !blockers.some(c => c.key.split(":")[0] === reason.key));
  useEffect(() => { onBlocked(blocked); }, [blocked, onBlocked]);
  if (data && !data.canWork) return null;
  return <section aria-live="polite" className="rounded-lg border border-rule p-4 text-sm"><h3 className="font-medium">{blocked || extraReasons.length ? "Complete these steps to send EOD" : "Ready to send"}</h3>{error ? <p>{error}</p> : !data ? <p>Loading checks…</p> : !job ? <p>Start work on this opening in the sidebar before sending.</p> : <>
    {(blockers.length > 0 || extraReasons.length > 0) && <ul className="mt-2 space-y-1">{blockers.map(c => <li key={c.key}><Link href={c.href} className="text-brand underline">{c.label}</Link>: {extraReasons.find(reason => reason.key === c.key.split(":")[0])?.message ?? c.progress ?? "needs action"}</li>)}{additionalReasons.map(reason => <li key={reason.key}>{reason.message}</li>)}</ul>}
    {!blocked && !extraReasons.length && <p className="text-green-700 dark:text-green-400">Required tasks are completed or excused. CVs will be checked and prepared when you send.</p>}
  </>}</section>;
}

function DailyReview({
  day,
  canFinish = false,
  reviewer = false,
  canManage = false,
}: {
  day: WorkdayView;
  canFinish?: boolean;
  reviewer?: boolean;
  canManage?: boolean;
}) {
  const blockers = completionBlockers(day.jobs);
  const displayedJobs = day.jobs.map(job => {
    const checks = [...job.checks, ...(job.eodChecks ?? []).filter(c => !job.checks.some(existing => existing.key === c.key))];
    const expanded = { ...job, checks };
    return { ...expanded, detailChecks: checks, checks: sidebarChecks(expanded) };
  });
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2">
        {!reviewer && <h2 className="font-semibold">
          {day.name} · {day.date}
        </h2>}
        <p className="text-sm">
          Started {workdayTime(day.startedAt)} ·{" "}
          {day.finishedAt
            ? `Finished ${workdayTime(day.finishedAt)}`
            : "Working"}
        </p>
      </div>
      {displayedJobs.map((job) => (
        <SavedDetails key={job.jobId} id={`${day.id}:${job.jobId}`} title={<>{job.title} · {job.workType} · {job.checks.filter(c => c.status === "complete").length} completed · {job.checks.filter(c => c.exception).length} reason{job.checks.filter(c => c.exception).length === 1 ? "" : "s"} submitted · {completionBlockers([job]).length} remaining</>}>
          <div className="flex flex-wrap justify-between gap-2">
            <Link
              className="font-semibold text-brand"
              href={`/openings/${job.jobId}`}
            >
              {job.title}
            </Link>
            <span className="text-sm">{job.workType}</span>
          </div>
          {canFinish && <WorkForm op="setWorkType" fields={{ workdayId: day.id, jobId: job.jobId }}><label className="block text-xs">Work type<select name="workType" defaultValue={job.workType} className={inputClass}><option>100%</option><option>Follow-up</option><option>Add-on</option></select></label><button className={buttonClass}>Set work type</button></WorkForm>}
          {job.workType === "100%" && <details><summary className="cursor-pointer text-xs text-ink-soft">Activity details</summary>
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
          {reviewer && <><p className="mt-3 text-sm font-medium">
            Shortlisted today and candidates still in progress
          </p>
          {job.shortlist.length ? (
            <ul className="mt-2 divide-y divide-rule text-xs">{job.shortlist.map(c => <li key={c.id} className="py-2"><p className="font-medium">{c.name}</p><p>{c.source} · {c.sent ? "Already sent" : c.stage === "director_review" ? "Ready to send" : c.stage.replaceAll("_", " ")}</p></li>)}</ul>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">
              No candidates shortlisted during this workday.
            </p>
          )}
          </>}
          </details>}
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
          {reviewer && job.detailChecks.some(c => !job.checks.some(summary => summary.key === c.key)) && <details>
            <summary className="cursor-pointer text-xs text-ink-soft">Candidate task details</summary>
            <ul>{job.detailChecks.filter(c => !job.checks.some(summary => summary.key === c.key)).map(check => <Check key={check.key} check={check} dayId={day.id} readOnly />)}</ul>
          </details>}
          {canManage && day.finishedAt === null && job.detailChecks.some(c => (c.kind === "cv_review" && c.status !== "complete") || c.key.startsWith("mail:")) && <details>
            <summary className="cursor-pointer text-xs text-brand">Review actions</summary>
          {canManage &&
            day.finishedAt === null &&
            job.detailChecks
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
                  <p className="text-xs text-ink-soft">{check.label}</p>
                  <button className="text-sm text-brand underline">
                    I reviewed this CV as TA Lead — record review
                  </button>
                </WorkForm>
              ))}
          {canManage &&
            day.finishedAt === null &&
            job.detailChecks
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
          </details>}
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
              ? `${blockers.length} required actions remain before finishing your workday.`
              : "Required checks are completed or excused. Waiting items will carry forward."}
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
  const params = useSearchParams();
  const requestedDay = params.get("checkDay");
  const requestedJob = params.get("checkJob") ?? "";
  const requestedFocus = `${requestedDay}:${requestedJob}:${params.get("checkTask")}`;
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);
  const focus = requestedDay && dismissedFocus !== requestedFocus ? { day: requestedDay, job: requestedJob } : null;
  const { data, error, load } = useWorkday(true, true, focus ? `&checkDay=${encodeURIComponent(focus.day)}` : `&date=${encodeURIComponent(date)}&cursor=${encodeURIComponent(cursor)}`);
  const finishedToday = data?.lastFinishedDate === workdayDate(Date.now());
  const team = (data?.team ?? []).filter(day => focus ? day.id === focus.day : (!ta || day.userId === ta) && (!date || day.date === date)).map(day => ({ ...day, jobs: day.jobs.filter(job => focus ? !focus.job || job.jobId === focus.job : !jobFilter || job.jobId === jobFilter).map(job => ({ ...job, checks: job.checks.filter(c => focus || !status || (c.exception ? "excused" : c.waiting ? "waiting" : c.status ?? "incomplete") === status) })) })).filter(day => day.jobs.length > 0 || day.requests.length > 0);
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
      {(data?.canReview ?? data?.canLead) && data && (
        <>
          <h2 className="text-lg font-semibold">Team checks</h2>{focus && <button className="text-xs text-brand underline" onClick={() => setDismissedFocus(requestedFocus)}>Show all workdays</button>}
          <details><summary className="cursor-pointer text-sm text-brand">Filter team checks</summary><div className="mt-3 space-y-3">
          <label className="block text-xs">Day<input type="date" value={date} onChange={e => { setDate(e.target.value); setCursor(""); }} className={inputClass} /></label>
          <label className="block text-xs">TA<select value={ta} onChange={e => setTa(e.target.value)} className={inputClass}><option value="">All TAs</option>{[...new Map(data.team.map(d => [d.userId, d.name])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="block text-xs">Job<select value={jobFilter} onChange={e => setJobFilter(e.target.value)} className={inputClass}><option value="">All jobs</option>{[...new Map(data.team.flatMap(d => d.jobs.map(j => [j.jobId, j.title] as const))).entries()].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label className="block text-xs">Task status<select value={status} onChange={e => setStatus(e.target.value)} className={inputClass}><option value="">All tasks</option><option value="incomplete">Incomplete</option><option value="complete">Complete</option><option value="waiting">Waiting</option><option value="excused">Reason submitted</option></select></label>
          </div></details>
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
            <SavedDetails key={day.id} id={`team:${day.id}`} initiallyOpen={false} title={<>{day.name} · {day.date} · {day.finishedAt ? "Finished" : "Working"}</>}>
              <DailyReview day={day} reviewer canManage={data.canLead} />
              {data.canLead && day.finishedAt === null &&
                day.requests
                  .filter((r) => r.status === "pending")
                  .map((request) => (
                    <details
                      key={request.id}
                      className="rounded-xl border border-rule p-5"
                    >
                      <summary className="cursor-pointer text-sm font-medium">
                        {day.name}: approval to work on {request.title}
                      </summary><div className="mt-3">
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
                    </div></details>
                  ))}
            </SavedDetails>
          ))}
          <div className="flex gap-3 text-xs">{cursor && <button className="text-brand underline" onClick={() => setCursor("")}>Latest records</button>}{data.nextCursor && <button className="text-brand underline" onClick={() => setCursor(data.nextCursor!)}>Older records</button>}</div>
        </>
      )}
    </div>
  );
}

/**
 * Standard rail — always visible on xl, toggle button on smaller screens.
 * Used by ta and ta_support roles.
 */
export function WorkdayRail() {
  const [open, setOpen] = useState(false);
  const params = useSearchParams();
  const requestedOpen = params.get("checks") === "open";
  useEffect(() => { if (requestedOpen) setOpen(true); }, [requestedOpen]);
  return <>
    {/* Small-screen toggle button — hidden once open, hidden on xl (always visible there) */}
    <button
      className={`${open ? "hidden" : ""} fixed right-3 z-30 rounded-lg border border-rule bg-surface p-2 text-sm shadow-sm xl:hidden`}
      style={{ top: "calc(var(--header-h) + 10px)" }}
      onClick={() => setOpen(true)}
      aria-expanded={open}
      aria-controls="workday-rail"
    >
      Today&apos;s checks
    </button>
    <aside
      id="workday-rail"
      aria-label="Today's workday checks"
      className={`${open ? "block" : "hidden"} fixed right-0 z-20 w-full max-w-96 overflow-y-auto border-l border-rule bg-surface p-3 pb-24 shadow-sm xl:block`}
      style={{ top: HEADER_H, bottom: 0 }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Today&apos;s Checks</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-brand xl:hidden">Close</button>
      </div>
      <WorkdayDashboard />
    </aside>
  </>;
}

/**
 * Pull-tab rail — closed by default on every screen size, including xl.
 * Used by TA leads, admins and directors; closed by default with an expand tab.
 * Clicking the tab slides the drawer in.
 */
export function WorkdayRailLeadAdmin() {
  const [open, setOpen] = useState(false);
  const params = useSearchParams();
  const requestedOpen = params.get("checks") === "open";
  useEffect(() => { if (requestedOpen) setOpen(true); }, [requestedOpen]);
  return <>
    {/* Expand button on the right edge — visible only when closed */}
    {!open && (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open Today's Checks"
        aria-expanded={false}
        aria-controls="workday-rail-lead"
        className="fixed z-40 flex items-center gap-1.5 rounded-l-lg border border-r-0 border-rule-strong bg-surface py-2.5 pl-3 pr-2.5 text-xs font-semibold text-fg shadow-md transition-all hover:bg-paper hover:shadow-lg hover:pr-3.5"
        style={{ top: "45%", transform: "translateY(-50%)", right: 0 }}
        title="Today's Checks"
      >
        <span className="text-sm font-bold text-brand">‹</span>
        <span>Today&apos;s Checks</span>
      </button>
    )}
    {/* Drawer — slides in from right, closed by default */}
    <aside
      id="workday-rail-lead"
      aria-hidden={!open}
      inert={!open}
      aria-label="Today's workday checks"
      className={`fixed right-0 z-40 w-full max-w-96 overflow-y-auto border-l border-rule bg-surface p-3 pb-24 shadow-xl transition-transform duration-200 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ top: HEADER_H, bottom: 0 }}
    >
      <div className="mb-4 flex items-center justify-between border-b border-rule pb-2">
        <h2 className="font-semibold text-sm">Today&apos;s Checks</h2>
        <button
          onClick={() => setOpen(false)}
          className="rounded px-2 py-1 text-xs font-medium text-brand hover:bg-tag"
          aria-label="Close Today's Checks"
        >
          ✕ Close
        </button>
      </div>
      <WorkdayDashboard />
    </aside>
  </>;
}

export function WorkdayWorkspace({ children, role }: { children: React.ReactNode; role: string }) {
  const isReviewer = canReviewWorkdays(role);
  // Team reviewers use the same compact drawer; TAs and support keep their worker rail.
  // ta/ta_support: 96-unit right padding reserved for the always-visible xl rail.
  return (
    <div className={isReviewer ? "" : "xl:pr-96"}>
      {children}
      <Suspense fallback={null}>
        {isReviewer ? <WorkdayRailLeadAdmin /> : <WorkdayRail />}
      </Suspense>
    </div>
  );
}
