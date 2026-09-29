import { externalUrl } from "@/lib/url";
import { cvSource, headhuntedCandidates } from "@/lib/cvSource";
import { channelTag } from "@/lib/format";
import Link from "next/link";
import { CvFrame } from "@/components/CvFrame";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import { STAGE_LABEL } from "@/data/types";
import { timeAt } from "@/lib/format";
import { claimCandidate } from "@/app/actions";
import { isWordFile } from "@/lib/wordToPdf";
import { SubmitButton } from "@/components/Submit";
import { RowActions } from "@/components/RowActions";
import { CallLogForm } from "@/components/CallLogForm";
import { ContactRow } from "@/components/ContactRow";
import { Confirm } from "@/components/Confirm";
import { ChevronIcon, CloseIcon } from "@/components/icons";
import { ClosingPanel } from "@/components/ClosingPanel";
import { Timeline } from "@/components/Timeline";
import { pageLink } from "@/lib/paging";
import { Interviews } from "@/components/InterviewPanel";
import { ScreeningPanel } from "@/components/ScreeningPanel";
import { CallLog, Chat } from "@/components/Dossier";
import { FollowUpPanel } from "@/components/FollowUpPanel";
import { ReviewDetailsForm } from "@/components/ReviewDetailsForm";
import { extractCareer141BoxFromText, isSystemNote } from "@/lib/pdf";
import { LiveFollowUp } from "@/components/LiveFollowUp";
import { AuraCallButton } from "@/components/AuraCallButton";
import { WebCallResults } from "@/components/WebCallResults";
import { VerifyReferee } from "@/components/VerifyReferee";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { primeStore } from "@/data/prime";
import { PreparedCvEditor } from "@/components/PreparedCvEditor";
import { cameFromTables } from "@/lib/pipeline";

/**
 * Finding 23 — Chat Log was a tab that explained why it was empty. A TA clicks
 * it repeatedly and gets the same paragraph. It comes back the day the WhatsApp
 * ingestion is connected and has threads to show.
 */
const TABS = ["cv", "prepared", "history", "call", "chat", "reference", "company_refs"] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  // Calls and messages stay apart: one is a TA's account of a conversation,
  // the other is the conversation.
  cv: "CV", prepared: "Prepared CV", history: "History", call: "Call Log", chat: "Chat", reference: "Reference", company_refs: "Company Reference",
};

export default async function CandidateDrawer({
  params, searchParams,
}: {
  params: Promise<{ id: string; appId: string }>;
  searchParams: Promise<{ tab?: string; msg?: string; q?: string; page?: string }>;
}) {
  const { id, appId } = await params;
  const sp = await searchParams;
  const { tab = "cv", q = "" } = sp;
  const logPage = Math.max(1, Math.floor(Number(sp.page)) || 1);
  await primeStore({ openingId: id, allApplications: tab === "company_refs" });
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
  let referees = repo.referees().filter((r) => r.fromCandidateId === c.id);

  // If memory store doesn't have referees for this candidate, query Convex directly (fast index lookup)
  if (referees.length === 0 && isConvex()) {
    try {
      const { convexQuery } = await import("@/lib/convexServer");
      const existingRefs = await convexQuery<any[]>("ta/tables:refereesFor", { candidateIds: [c.id] }).catch(() => []);
      if (existingRefs && existingRefs.length > 0) {
        referees = existingRefs;
      }
    } catch (err) {
      console.warn("[candidate page] Referee lookup failed:", err);
    }
  }

  // Every interview, soonest first — a finished one still needs its result
  // and feedback, so none are hidden (28 Sep: several per candidate).
  const interviews = repo.interviews(appId).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const interview = interviews.find((i) => i.outcome === "pending") ?? interviews.at(-1);

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

  const presentCompany = (c.currentEmployer ?? "").trim();
  const targetCompany = presentCompany || (c.workHistory?.[0]?.employer ?? "").trim();
  let companyColleagues = targetCompany
    ? repo.peopleAtCompany(targetCompany, c.id)
    : [];

  if (isConvex() && targetCompany && tab === "company_refs") {
    try {
      const { convexQuery } = await import("@/lib/convexServer");
      const backendResults = await convexQuery<{
        candidates: { id: string; fullName: string; currentTitle: string; currentEmployer: string; phone: string | null; email: string | null }[];
      }>("ta/candidates:peopleAtCompany", {
        company: targetCompany,
        excludeCandidateId: c.id,
      }).catch(() => null);

      if (backendResults?.candidates) {
        const existingColleagueIds = new Set(companyColleagues.map((cand) => cand.id));
        for (const cand of backendResults.candidates) {
          if (!existingColleagueIds.has(cand.id)) {
            companyColleagues.push(cand as any);
            existingColleagueIds.add(cand.id);
          }
        }
      }
    } catch (err) {
      console.warn("[candidate page] peopleAtCompany Convex lookup failed:", err);
    }
  }

  // Counted off the real records now, not from the application's shape.
  const COUNTS: Record<(typeof TABS)[number], number | null> = {
    cv: null,
    prepared: null,
    history: repo.events(app.id).length + 1,
    call: calls.length + repo.outreach(app.id).filter((m) => m.channel === "ai_call").length,
    chat: repo.outreach(app.id).filter((m) => m.channel !== "ai_call").length,
    reference: referees.length,
    company_refs: companyColleagues.length,
  };

  // The candidate's own CV file, looked up only when the tab shows it.
  const cvFile =
    (tab === "cv" || tab === "prepared") && isConvex()
      ? await backend.cvFile(c.id).catch((e) => ({
          ok: false as const,
          reason: "storage_unavailable" as const,
          detail: `The CV could not be looked up (${(e as Error).message}).`,
          fileName: null,
        }))
      : null;
  const cvVersion = (cvFile?.ok && cvFile.fileName ? cvFile.fileName : "") || (c.cvFileName ?? "1");
  const cvHref = `/api/cv/${encodeURIComponent(c.id)}?app=${encodeURIComponent(app.id)}&v=${encodeURIComponent(cvVersion)}`;
  const cvIsPdf =
    !!cvFile?.ok &&
    (/pdf/i.test(cvFile.fileType ?? "") ||
      /\.pdf$/i.test(cvFile.fileName ?? "") ||
      /\.pdf$/i.test(c.cvFileName ?? "") ||
      !/\.(docx?|rtf|txt|png|jpe?g)$/i.test(cvFile.fileName ?? c.cvFileName ?? ""));

  // Shown as a PDF made from it (lib/wordToPdf); Download still gives the Word file.
  const cvIsWord = !!cvFile?.ok && !cvIsPdf && isWordFile(cvFile.fileName ?? c.cvFileName);

  const base = `/openings/${id}/candidate/${appId}`;
  const tabHref = (t: string) => (t === "cv" ? `${base}` : `${base}?tab=${t}`);
  const logHref = pageLink(base, sp);

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

      <section className="grid gap-5 rounded-2xl border border-rule bg-surface p-6 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <div className="flex gap-5">
          <span className="grid h-[84px] w-[84px] shrink-0 place-items-center rounded-full bg-[#c9a227] text-[24px] font-semibold text-white">{initials}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[22px] font-semibold tracking-tight">{c.fullName}</h2>
              <span className="rounded bg-tag px-1.5 py-[3px] text-[11px] font-medium text-ink-soft">{channelTag(app.sourcingChannel, cvSource(app, headhuntedCandidates(repo.linkVault(app.openingId))))}</span>
              {app.isAddOn && <span className="rounded bg-brand-soft px-1.5 py-[3px] text-[11px] font-medium text-brand">Add-on</span>}
              {app.backupForApplicationId && <span className="rounded bg-brand-soft px-1.5 py-[3px] text-[11px] font-medium text-brand">Backup</span>}
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
                  href={externalUrl(c.linkedinUrl) ?? undefined}
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
                  <SubmitButton
                    pendingLabel="Saving…"
                    className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-70"
                  >
                    Save to pipeline
                  </SubmitButton>
                </form>
              ) : (
                <RowActions
                  appId={app.id}
                  openingId={id}
                  current={app.stage}
                  candidate={c}
                  isAddOn={app.isAddOn}
                  isBackup={!!app.backupForApplicationId}
                  canDecideDirector={canDecideDirector}
                  canDecideClient={canDecideClient}
                  backToTables={cameFromTables(app, repo.linkVault(id))}
                />
              )}
              <span className="text-[12px] text-ink-faint">In {(STAGE_LABEL[app.stage] ?? app.stage ?? "").toLowerCase()}{app.setNumber ? ` · set ${app.setNumber}` : ""}</span>
            </div>
          </div>
        </div>

      </section>


      {/* Attendance and result, which nothing could record before. */}
      <Interviews
        interviews={interviews}
        appId={app.id}
        openingId={opening.id}
        canBook={app.stage === "client_shortlist" || app.stage === "interview"}
        locked={locked}
        canFeedback={allows(user, "interview.feedback", { openingId: id, assignment })}
        user={user}
        nameOf={(uid) => repo.user(uid)?.name ?? "Someone"}
      />

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

      {/* Everything Director Review asks for, typed in by hand when it came in
          outside the follow-up. Shown until they are past Follow-up. */}
      {!locked && ["new_cv", "matched", "ai_follow_up", "ta_follow_up", "follow_up"].includes(app.stage) && (
        <ReviewDetailsForm
          applicationId={app.id}
          openingId={id}
          currentSalary={c.currentSalary}
          expectedSalary={c.expectedSalary}
          noticePeriodDays={c.noticePeriodDays}
          noticePeriod={c.noticePeriod}
          hasCv={Boolean(c.cvFileName || cvFile?.ok)}
          notes={app.notes?.filter((n) => !isSystemNote(n))}
        />
      )}

      <nav className="mt-4 flex gap-6 border-b border-rule px-1">
        {TABS.filter((t) => t !== "reference" || referees.length > 0).map((t) => {
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
                it — so the candidate's own file is the tab, and the parsed fields
                sit under it for filtering and for the end-of-day email.

                This showed the prepared CV, a page generated from the parsed
                fields, in place of the file — so every candidate's CV looked
                like the same template. The prepared version (with the green
                Career141 block, for the Director and the client) is still one
                click away. */}
            <div className="mb-5 overflow-hidden rounded-xl border border-rule">
              {cvFile?.ok && (cvIsPdf || cvIsWord) ? (
                <CvFrame
                  src={cvIsWord ? `${cvHref}&view=pdf` : cvHref}
                  title={`CV — ${c.fullName}`}
                  fileName={(cvFile?.ok ? cvFile.fileName : null) ?? c.cvFileName ?? "CV"}
                  downloadHref={`${cvHref}&download=1`}
                  preparedCvHref={`/api/prepared-cv/${app.id}`}
                />
              ) : cvFile?.ok ? (
                <div className="p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
                    <span className="text-[12.5px] font-medium">
                      {(cvFile?.ok ? cvFile.fileName : null) ?? c.cvFileName ?? "CV"}
                    </span>
                    <a href={`${cvHref}&download=1`} className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] text-brand hover:bg-tag">
                      Download CV
                    </a>
                  </div>
                  <p className="px-4 py-8 text-center text-[12.5px] text-ink-soft">
                    This CV is not a PDF, so the browser cannot show it inline.{" "}
                    <a href={`${cvHref}&download=1`} className="text-brand hover:underline">
                      Download it
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <p className="px-4 py-10 text-center text-[12.5px] text-ink-soft">
                  {cvFile?.detail ?? "No CV file is on record for this candidate."}
                </p>
              )}
            </div>

            {/* References from the CV */}
            <div className="mt-6 rounded-xl border border-rule bg-paper p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-ink">References</h3>
                {referees.length > 0 && (
                  <span className="text-[12px] text-ink-faint">
                    {referees.length} named on CV
                  </span>
                )}
              </div>
              {/* The full list, with Verify, lives on the Reference tab; the CV
                  tab names who they are and links there, so the same referees
                  are not listed twice (review of PR #11, 22 September). */}
              {referees.length === 0 ? (
                <p className="py-2 text-[12.5px] text-ink-faint">No referees named on this CV.</p>
              ) : (
                <p className="py-1 text-[12.5px] text-ink-soft">
                  {referees.map((r) => r.name).join(", ")}.{" "}
                  <Link href={tabHref("reference")} className="font-medium text-brand hover:underline">
                    Details and verify on the Reference tab →
                  </Link>
                </p>
              )}
            </div>
          </>
        )}

        {/* The CV as the Director and client get it, with the CAREER141 box the
            TA can drag into place (29 Sep). */}
        {tab === "prepared" && (
          <PreparedCvEditor
            appId={app.id}
            openingId={opening.id}
            pdfSrc={cvFile?.ok && (cvIsPdf || cvIsWord) ? (cvIsWord ? `${cvHref}&view=pdf` : cvHref) : null}
            canEdit={!locked}
          />
        )}

        {tab === "history" && (
          <Timeline
            applicationId={app.id}
            createdAt={app.createdAt}
            sourcingChannel={app.sourcingChannel}
            q={q}
            page={logPage}
            pageHref={logHref}
          />
        )}

        {tab === "call" && (
          <div className="flex flex-col gap-5">
            {/* The screening call and the chase are the owner's to run. Hiding
                them for anyone else matches what the server will allow. */}
            {isConvex() && !locked && (
              <div className="rounded-xl border border-rule bg-paper p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[13px] font-semibold">Screening call with Aura</h3>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                      Aura calls from Career141 about the {opening.title} role and asks current salary, expected salary,
                      notice period{opening.followUpQuestions.length > 0 ? " and this opening's own questions" : ""}. The answers
                      are saved to the candidate when the call ends.
                    </p>
                  </div>
                  <AuraCallButton applicationId={app.id} openingId={id} candidateName={c.fullName} roleTitle={opening.title} />
                </div>
              </div>
            )}
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
            <CallLog applicationId={app.id} q={q} page={logPage} pageHref={logHref} />
          </div>
        )}

        {tab === "chat" && (
          <div className="flex flex-col gap-5">
            {/* The chase is WhatsApp and email, so it is run from the chat. On
                the Convex store it is the real sequence, sent and read by the
                backend; the file store keeps the drafting desk. */}
            {isConvex() ? (
              <LiveFollowUp
                applicationId={app.id}
                openingId={id}
                actorId={user.id}
                locked={locked}
                candidateName={c.fullName}
                roleTitle={opening.title}
                hasPhone={!!(c.phone ?? "").replace(/\D/g, "")}
                hasEmail={!!c.email}
              />
            ) : (
              <>
                {!locked && <FollowUpPanel applicationId={app.id} openingId={id} taName={user.name} mode="chat" />}
                <Chat applicationId={app.id} q={q} page={logPage} pageHref={logHref} />
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
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium text-ink">{r.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-ink-soft">
                      {r.title ?? "Role not on the CV"}
                      {r.company && (
                        <>
                          <span className="text-ink-faint"> at </span>
                          {r.company}
                        </>
                      )}
                      <span className="ml-1.5 text-[11px] text-ink-faint">(from the CV)</span>
                    </p>
                    {r.relationship && <p className="mt-1 text-[12px] text-ink-faint">{r.relationship}</p>}
                  </div>
                  <div className="shrink-0 text-right text-[12.5px]">
                    {r.phone ? (
                      <span className="tabular block font-medium">{r.phone}</span>
                    ) : (
                      <span className="block text-ink-faint">No number on file</span>
                    )}
                    {r.email && <span className="mt-0.5 block text-[11.5px] text-ink-faint">{r.email}</span>}
                    <VerifyReferee refereeId={r.id} openingId={id} />
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "company_refs" && (
          <div className="flex flex-col gap-5">
            {/* Header: Company Name and Count */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
              <div>
                <span className="text-[12px] font-semibold uppercase tracking-wider text-brand">Present Company</span>
                <h3 className="mt-0.5 text-[18px] font-bold tracking-tight text-ink">
                  {targetCompany || "No employer listed on candidate profile"}
                </h3>
              </div>

              <span className="rounded-full bg-tag px-3 py-1 text-[12px] font-medium text-ink">
                {companyColleagues.length} {companyColleagues.length === 1 ? "person" : "people"} in database
              </span>
            </div>

            {/* Candidates from Database */}
            {!targetCompany ? (
              <div className="py-10 text-center text-[13px] text-ink-faint">
                No company listed on this candidate&rsquo;s profile.
              </div>
            ) : companyColleagues.length === 0 ? (
              <div className="py-10 text-center text-[13px] text-ink-faint">
                No other candidates from <span className="font-medium text-ink-soft">{targetCompany}</span> found in the database.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {companyColleagues.map((colleague) => {
                  const apps = repo.applicationsForCandidate(colleague.id);
                  const latestApp = apps[0];
                  return (
                    <div
                      key={colleague.id}
                      className="flex flex-col justify-between rounded-xl border border-rule bg-paper p-4 transition-colors hover:border-brand-line"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[14px] font-semibold text-ink">{colleague.fullName}</span>
                          {latestApp ? (
                            <span className="rounded bg-tag px-1.5 py-0.5 text-[10.5px] text-ink-faint">
                              {STAGE_LABEL[latestApp.stage] ?? latestApp.stage}
                            </span>
                          ) : (
                            <span className="rounded bg-tag px-1.5 py-0.5 text-[10.5px] text-ink-faint">
                              Database Candidate
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[12.5px] font-medium text-ink-soft">{colleague.currentTitle || "Position not listed"}</p>
                        <p className="mt-0.5 text-[11.5px] text-ink-faint">{colleague.currentEmployer || targetCompany}</p>
                      </div>

                      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-rule/60 pt-2 text-[12px]">
                        <div className="text-ink-soft">
                          {colleague.phone ? (
                            <a href={`tel:${colleague.phone}`} className="tabular mr-2 font-medium text-brand hover:underline">
                              {colleague.phone}
                            </a>
                          ) : colleague.email ? (
                            <a href={`mailto:${colleague.email}`} className="text-ink-soft hover:underline">
                              {colleague.email}
                            </a>
                          ) : (
                            <span className="text-ink-faint">No direct contact</span>
                          )}
                        </div>
                        {latestApp && (
                          <Link
                            href={`/openings/${latestApp.openingId}/candidate/${latestApp.id}`}
                            className="font-medium text-brand hover:underline"
                          >
                            View profile →
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
          </div>
        </div>
      </div>
    </>
  );
}
