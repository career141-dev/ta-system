import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import { STAGE_LABEL } from "@/data/types";
import { timeAt } from "@/lib/format";
import { claimCandidate } from "@/app/actions";
import { RowActions } from "@/components/RowActions";
import { CallLogForm } from "@/components/CallLogForm";
import { ContactRow } from "@/components/ContactRow";
import { Confirm } from "@/components/Confirm";
import { ChevronIcon, CloseIcon } from "@/components/icons";
import { ClosingPanel } from "@/components/ClosingPanel";
import { Timeline } from "@/components/Timeline";
import { InterviewPanel } from "@/components/InterviewPanel";
import { ScreeningPanel } from "@/components/ScreeningPanel";
import { CallLog, Chat } from "@/components/Dossier";
import { FollowUpPanel } from "@/components/FollowUpPanel";
import { LiveFollowUp } from "@/components/LiveFollowUp";
import { WebCallPanel } from "@/components/WebCallPanel";
import { WebCallResults } from "@/components/WebCallResults";
import { isConvex } from "@/data/mode";
import { removeApplication } from "@/app/actions";
import { primeStore } from "@/data/prime";

/**
 * Finding 23 — Chat Log was a tab that explained why it was empty. A TA clicks
 * it repeatedly and gets the same paragraph. It comes back the day the WhatsApp
 * ingestion is connected and has threads to show.
 */
const TABS = ["cv", "history", "call", "chat", "reference"] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  // Calls and messages stay apart: one is a TA's account of a conversation,
  // the other is the conversation.
  cv: "CV", history: "History", call: "Call Log", chat: "Chat", reference: "Reference",
};

export default async function CandidateDrawer({
  params, searchParams,
}: {
  params: Promise<{ id: string; appId: string }>;
  searchParams: Promise<{ tab?: string; msg?: string }>;
}) {
  const { id, appId } = await params;
  const { tab = "cv" } = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();

  const app = repo.application(appId);
  const opening = repo.opening(id);
  // The application has to belong to the opening in the address. Without this
  // a Brand Manager candidate rendered under the Head of Finance header, with
  // working controls (audit finding 20).
  if (!app || !opening || app.openingId !== opening.id) notFound();

  // Reading is checked here too, not only in the rail: a person not on this
  // opening, or a client seat looking at a stage before their shortlist, gets
  // nothing rather than a page with the buttons hidden.
  const assignment = repo.assignmentFor(id, user.id) ?? null;
  const seat = seatFor(user, assignment?.role ?? null);
  if (!allows(user, "opening.read", { openingId: id, assignment })) notFound();
  if (seat.stages !== null && !seat.stages.includes(app.stage)) notFound();
  const c = repo.candidate(app.candidateId);
  const client = repo.client(opening.clientId);
  if (!c || !client) notFound();

  const owner = repo.user(app.ownerTaId ?? "");
  const calls = repo.callFeedback(appId);
  const referees = repo.referees().filter((r) => r.fromCandidateId === c.id);
  // The most recent interview, whatever state it is in — a finished one still
  // needs its result recording, and only showing pending ones is why there was
  // nowhere to record it.
  const interviews = repo.interviews(appId).sort((a, b) => b.scheduledAt - a.scheduledAt);
  const interview = interviews.find((i) => i.outcome === "pending") ?? interviews[0];

  // Prev / next within the same stage, in the order the list shows them.
  const siblings = repo.applications(id).filter((a) => a.stage === app.stage);
  const index = siblings.findIndex((s) => s.id === appId);
  const prev = index > 0 ? siblings[index - 1] : null;
  const next = index < siblings.length - 1 ? siblings[index + 1] : null;
  // Every opening this person has been on, so the drawer is about the person
  // rather than this one application.
  const onOpenings = repo.applicationsForCandidate(c.id).map((a) => {
    const o = repo.opening(a.openingId);
    return {
      id: a.id,
      openingId: a.openingId,
      openingTitle: o?.title ?? "—",
      clientName: repo.client(o?.clientId ?? "")?.name ?? "—",
      stageLabel: STAGE_LABEL[a.stage],
    };
  });

  // Counted off the real records now, not from the application's shape.
  const COUNTS: Record<(typeof TABS)[number], number | null> = {
    cv: null,
    history: repo.events(app.id).length + 1,
    call: calls.length + repo.outreach(app.id).filter((m) => m.channel === "ai_call").length,
    chat: repo.outreach(app.id).filter((m) => m.channel !== "ai_call").length,
    reference: referees.length,
  };

  const base = `/openings/${id}/candidate/${appId}`;
  const tabHref = (t: string) => (t === "cv" ? `${base}` : `${base}?tab=${t}`);

  // One test, the same one every action on this page makes on the server.
  const locked = !allows(user, "opening.act", { openingId: id, assignment, ownerTaId: app.ownerTaId });
  const canDecideDirector = allows(user, "decide.director", { openingId: id, assignment });
  const canDecideClient = allows(user, "decide.client", { openingId: id, assignment });
  const initials = c.fullName.split(" ").map((p) => p[0]).join("").slice(0, 2);

  // Where ✕ goes: the list this person was opened from. New CVs do not have a
  // pipeline route of their own — they are read on the job.
  const closeHref =
    app.stage === "new_cv"
      ? `/openings/${id}/linkedin-job`
      : app.stage === "matched"
        ? `/openings/${id}/database`
        : `/openings/${id}/pipeline/${app.stage}`;

  return (
    <>
      {/* A sheet over the desk, the way Recruiter opens a candidate: the rail
          stays visible and dimmed so you know where you are, and everything
          else is the person in front of you. Clicking the dim closes it. */}
      <Link
        href={closeHref}
        aria-label="Close"
        className="fixed inset-0 z-40 bg-[#0b1a12]/60"
      />

      <div className="fixed inset-y-0 left-0 right-0 z-50 flex flex-col bg-paper shadow-[-8px_0_40px_rgba(11,26,18,.18)] lg:left-[238px]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule bg-surface px-7 py-4">
          <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
            From {client.name.toUpperCase()} - {opening.title} - {(owner?.name ?? "unclaimed").toUpperCase()}
          </h1>
          <div className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink-soft">
            {prev ? (
              <Link href={`/openings/${id}/candidate/${prev.id}${tab !== "cv" ? `?tab=${tab}` : ""}`} className="grid h-7 w-7 place-items-center rounded hover:bg-tag hover:text-ink" title="Previous"><ChevronIcon dir="left" /></Link>
            ) : <span className="px-1.5 text-ink-faint/50"><ChevronIcon dir="left" /></span>}
            <span className="tabular">{index + 1} of {siblings.length}</span>
            {next ? (
              <Link href={`/openings/${id}/candidate/${next.id}${tab !== "cv" ? `?tab=${tab}` : ""}`} className="grid h-7 w-7 place-items-center rounded hover:bg-tag hover:text-ink" title="Next"><ChevronIcon dir="right" /></Link>
            ) : <span className="px-1.5 text-ink-faint/50"><ChevronIcon dir="right" /></span>}
            <Link href={closeHref} className="ml-2 grid h-7 w-7 place-items-center rounded hover:bg-tag hover:text-ink" title="Back to the list"><CloseIcon size={16} /></Link>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto flex max-w-[1000px] flex-col">

      <section className="grid gap-5 rounded-2xl border border-rule bg-surface p-6 shadow-[0_1px_2px_rgba(23,28,24,0.04)] xl:grid-cols-[minmax(0,1fr)_264px]">
        <div className="flex gap-5">
          <span className="grid h-[84px] w-[84px] shrink-0 place-items-center rounded-full bg-[#c9a227] text-[24px] font-semibold text-white">{initials}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[22px] font-semibold tracking-tight">{c.fullName}</h2>
              <span className="rounded bg-tag px-1.5 py-[3px] text-[11px] font-medium text-ink-soft">{app.sourcingChannel === "HH" ? "Sourced" : app.sourcingChannel === "SCOOP" ? "Database" : "Applicant"}</span>
              {app.isAddOn && <span className="rounded bg-brand-soft px-1.5 py-[3px] text-[11px] font-medium text-brand">Add-on</span>}
            </div>
            <p className="mt-1 text-[14px]">{c.currentTitle}</p>
            <p className="mt-0.5 text-[12px] text-ink-faint">{[c.currentEmployer, c.educationInstitution, c.location].filter(Boolean).join(" · ")}</p>
            {/* Contact rows carry their own controls, the way Recruiter does —
                a wrong number is corrected where it is read, not in a form. */}
            <div className="mt-3.5 flex flex-col gap-2 text-[13px]">
              <ContactRow kind="email" value={c.email} candidateId={c.id} openingId={id} locked={locked} />
              <ContactRow kind="phone" value={c.phone} candidateId={c.id} openingId={id} locked={locked} />
              {c.linkedinUrl && (
                <a
                  href={c.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
                >
                  <span className="grid h-[15px] w-[15px] place-items-center rounded-[2px] bg-accent text-[9px] font-bold leading-none text-white">
                    in
                  </span>
                  Public profile
                </a>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {locked ? (
                <p className="rounded-lg border border-rule bg-paper px-3.5 py-2 text-[12px] text-ink-soft">
                  Shortlisted by <span className="text-ink">{owner?.name}</span> — you cannot contact
                </p>
              ) : !app.ownerTaId ? (
                <form action={claimCandidate}>
                  <input type="hidden" name="appId" value={app.id} />
                  <input type="hidden" name="openingId" value={id} />
                  <button className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90">Save to pipeline</button>
                </form>
              ) : (
                <RowActions
                  appId={app.id}
                  openingId={id}
                  current={app.stage}
                  isAddOn={app.isAddOn}
                  canDecideDirector={canDecideDirector}
                  canDecideClient={canDecideClient}
                />
              )}
              <span className="text-[12px] text-ink-faint">In {STAGE_LABEL[app.stage].toLowerCase()}{app.setNumber ? ` · set ${app.setNumber}` : ""}</span>
            </div>
          </div>
        </div>

        {/* Where this application stands, kept out of the reading column so the
            person and the paperwork are not interleaved. */}
        <dl className="flex flex-col gap-3 self-start rounded-xl border border-rule bg-paper px-4 py-3.5 text-[12.5px]">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-faint">Stage</dt>
            <dd className="font-medium">{STAGE_LABEL[app.stage]}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-faint">Owner</dt>
            <dd className="font-medium">{owner?.name ?? "Unclaimed"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-faint">Source</dt>
            <dd className="font-medium">{app.sourcingChannel}</dd>
          </div>
          {app.setNumber && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">Set</dt>
              <dd className="tabular font-medium">{app.setNumber}</dd>
            </div>
          )}
          {interview && interview.outcome === "pending" && (
            <div className="flex items-baseline justify-between gap-3 border-t border-rule pt-3">
              <dt className="text-ink-faint">Interview</dt>
              <dd className={`font-medium ${interview.confirmedAt ? "text-brand" : "text-warn"}`}>
                {interview.confirmedAt ? "Confirmed" : "Awaiting confirmation"}
              </dd>
            </div>
          )}

          {/* Takes them off this role only — the CV and everything else the
              database holds on them stays. */}
          {!locked && (
            <form action={removeApplication} className="border-t border-rule pt-3">
              <input type="hidden" name="appId" value={app.id} />
              <input type="hidden" name="openingId" value={id} />
              <Confirm
                label="Remove from this opening"
                question={`Take ${c.fullName.split(" ")[0]} off ${opening.title}? Their record stays in the database.`}
                confirmLabel="Remove"
                className="text-[12px] text-ink-faint transition-colors hover:text-danger"
              />
            </form>
          )}
        </dl>
      </section>


      {/* Attendance and result, which nothing could record before. */}
      {interview && <InterviewPanel interview={interview} openingId={opening.id} locked={locked} />}

      {/* The offer, once a candidate is far enough along for it to mean
          anything. Its own band rather than a tab: an offer out is a fact
          about this person that should be visible without opening anything. */}
      <ClosingPanel
        app={app}
        openingId={opening.id}
        offer={repo.offers(app.id)[0]}
        placement={repo.placementForApplication(app.id)}
        expectedSalary={c.expectedSalary}
        locked={locked}
      />

      {/* Which openings this person sits on, and where. Recruiter puts this
          immediately under the header because it is the first thing a TA needs
          before they touch anything. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-rule bg-paper px-5 py-3 text-[12.5px]">
        <span className="text-ink-faint">
          In {onOpenings.length} {onOpenings.length === 1 ? "opening" : "openings"}
        </span>
        {onOpenings.map((a) => (
          <span key={a.id} className="flex items-center gap-1.5">
            <Link
              href={`/openings/${a.openingId}/candidate/${a.id}`}
              className={`font-medium ${a.id === app.id ? "text-ink" : "text-accent hover:underline"}`}
            >
              {a.openingTitle}
            </Link>
            <span className="text-ink-faint">{a.clientName} · {a.stageLabel}</span>
            {a.id === app.id && (
              <span className="rounded bg-tag px-1.5 py-[2px] text-[10.5px] font-medium text-ink-soft">
                Current
              </span>
            )}
          </span>
        ))}
      </div>

      <nav className="mt-4 flex gap-6 border-b border-rule px-1">
        {TABS.map((t) => {
          // A count on every tab that can have one, so a TA knows whether a tab
          // is worth opening before they open it.
          const n = COUNTS[t];
          return (
            <Link key={t} href={tabHref(t)} className={`-mb-px border-b-2 px-1 pb-2.5 text-[13.5px] ${tab === t ? "border-brand font-semibold text-brand" : "border-transparent text-ink-soft hover:text-ink"}`}>
              {TAB_LABEL[t]}
              {n !== null && <span className="tabular ml-1.5 text-[12px] text-ink-faint">({n})</span>}
            </Link>
          );
        })}
      </nav>

      <section className="mt-4 rounded-2xl border border-rule bg-surface p-6 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        {tab === "cv" && (
          <>
            {/* The CV is a document. A TA reads it, they do not read a summary of
                it — so the document is the tab, and the parsed fields sit under
                it for filtering and for the end-of-day email. */}
            <div className="mb-5 overflow-hidden rounded-xl border border-rule">
              <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-paper px-4 py-2.5">
                <span className="text-[12.5px] font-medium">{c.cvFileName ?? "Prepared CV"}</span>
                <span className="text-[11.5px] text-ink-faint">
                  opens with the green block on page one
                </span>
                <a
                  href={`/api/prepared-cv/${app.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
                >
                  Open in a new tab
                </a>
              </div>
              <object
                data={`/api/prepared-cv/${app.id}#view=FitH`}
                type="application/pdf"
                className="h-[660px] w-full bg-paper"
                aria-label={`CV for ${c.fullName}`}
              >
                <p className="px-4 py-10 text-center text-[12.5px] text-ink-soft">
                  Your browser will not display the PDF inline.{" "}
                  <a href={`/api/prepared-cv/${app.id}`} className="text-brand hover:underline">
                    Open it in a new tab
                  </a>
                  .
                </p>
              </object>
            </div>

            <h3 className="mb-2.5 text-[13px] font-semibold">What we hold on file</h3>
            <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-3 text-[13px]">
            <dt className="font-semibold">Experience</dt><dd className="text-ink-soft">{c.totalExperienceYears} years · {c.currentTitle} at {c.currentEmployer}</dd>
            <dt className="font-semibold">Education</dt><dd className="text-ink-soft">{c.educationDegree} — {c.educationInstitution}</dd>
            <dt className="font-semibold">English</dt><dd className="tabular text-ink-soft">{c.englishLevel}/10</dd>
            <dt className="font-semibold">Age</dt><dd className="tabular text-ink-soft">{c.age}</dd>
            <dt className="font-semibold">Nationality</dt><dd className="text-ink-soft">{c.nationality}</dd>
            <dt className="font-semibold">Current</dt><dd className="text-ink-soft">{c.currentSalary}</dd>
            <dt className="font-semibold">Expected</dt><dd className="text-ink-soft">{c.expectedSalary}</dd>
            <dt className="font-semibold">Notice</dt><dd className="tabular text-ink-soft">{c.noticePeriodDays} days</dd>
            <dt className="font-semibold">Notes</dt><dd className="whitespace-pre-line text-ink-soft">{app.notes.join("\n")}</dd>
          </dl>
          </>
        )}

        {tab === "history" && (
          <Timeline
            applicationId={app.id}
            createdAt={app.createdAt}
            sourcingChannel={app.sourcingChannel}
          />
        )}

        {tab === "call" && (
          <div className="flex flex-col gap-5">
            {/* The screening call and the chase are the owner's to run. Hiding
                them for anyone else matches what the server will allow. */}
            {isConvex() && !locked && <WebCallPanel applicationId={app.id} openingId={id} />}
            {isConvex() && <WebCallResults applicationId={app.id} actorId={user.id} />}
            {!isConvex() && !locked && <FollowUpPanel applicationId={app.id} openingId={id} taName={user.name} mode="call" />}
            {!isConvex() && !locked && (
              <ScreeningPanel
                app={app}
                candidate={c}
                openingId={opening.id}
                roleTitle={opening.title}
                taName={user.name}
                calls={repo.calls(app.id)}
                inline
              />
            )}
            {!locked && (
              <CallLogForm
                applicationId={app.id}
                openingId={id}
                defaultKind={interview ? "pre_interview" : app.stage === "offer" ? "post_offer" : "ad_hoc"}
              />
            )}
            <CallLog applicationId={app.id} />
          </div>
        )}

        {tab === "chat" && (
          <div className="flex flex-col gap-5">
            {/* The chase is WhatsApp and email, so it is run from the chat. On
                the Convex store it is the real sequence, sent and read by the
                backend; the file store keeps the drafting desk. */}
            {isConvex() ? (
              <LiveFollowUp applicationId={app.id} openingId={id} actorId={user.id} locked={locked} />
            ) : (
              <>
                {!locked && <FollowUpPanel applicationId={app.id} openingId={id} taName={user.name} mode="chat" />}
                <Chat applicationId={app.id} />
              </>
            )}
          </div>
        )}

        {tab === "reference" && (
          referees.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-faint">No referees named on this CV.</p>
          ) : (
            <div className="divide-y divide-rule">
              {referees.map((r) => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
                  <div><p className="text-[13.5px] font-medium">{r.name}</p><p className="text-[12.5px] text-ink-soft">{r.title} at {r.company}</p><p className="mt-0.5 text-[11.5px] text-ink-faint">{r.relationship}</p></div>
                  <div className="text-right text-[12.5px]">{r.phone ? <span className="tabular block">{r.phone}</span> : <span className="block text-ink-faint">No number</span>}<span className="block text-[11.5px] text-ink-faint">{r.email}</span></div>
                </div>
              ))}
            </div>
          )
        )}
      </section>
          </div>
        </div>
      </div>
    </>
  );
}
