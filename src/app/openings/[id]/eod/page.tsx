import Link from "next/link";
import { notFound } from "next/navigation";
import { repo, setsForOpening, SET_SIZE } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { EodComposer } from "@/components/EodComposer";
import { effortRow, shortlistRows, subjectLine } from "@/lib/eod";
import { EOD_CC_DEFAULTS, EOD_TO, eodEmailHtml, needsResearchLink, revisedSubject, validateResearchLink } from "@/lib/eod-format";
import type { EodEmailCopy, User } from "@/data/types";
import { readEodReply, readInboundReply, addMiddayEmail } from "@/app/actions";
import { DailyEmailHistory, DailyEmailView } from "@/components/DailyEmailHistory";
import type { DailyEmail } from "@/lib/dailyEmail";
import { workdayDate } from "@/lib/workday";
import { convexQuery } from "@/lib/convexServer";
import { SubmitButton } from "@/components/Submit";
import { timeAt } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { requireSourcingSeat } from "../sourcingGate";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";
import { extractReplyText } from "@/lib/reviewReply";
import { isTa } from "@/lib/auth";
import { eyeMarkedForEmail, primeEyeMarked } from "@/lib/eyeMarkedStore";
import { EyeMarkedChecks } from "@/components/EyeMarkedChecks";
import { LiveTableRefresh } from "@/components/LiveTableRefresh";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { isWordFile } from "@/lib/wordToPdf";
import type { ShortlistRow } from "@/lib/eod-format";

const PAGE_SIZE = 10;

/**
 * The email that goes out at the end of the day, and the reply that comes back.
 *
 * One screen, because it is one thing. Pressing Send records the round — who
 * went out, in what order, to whom. The reply is read against exactly that
 * list and moves people: to the Director shortlist when it is the Director
 * answering, to the Client shortlist when it is the client.
 *
 * The Director's copy and the client's copy are the same table one stage
 * apart, so they are the same screen with the recipient switched rather than
 * two screens that drift.
 */
export default async function EodPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string; msg?: string; q?: string; page?: string; resend?: string; view?: string; mode?: string; mail?: string; revise?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const midday = sp.mode === "midday";
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);
  const kind: "director" | "client" = !midday && sp.kind === "client" ? "client" : "director";
  const user = await getCurrentUser();
  const dailyEmails = kind === "director" && isConvex() ? await convexQuery<DailyEmail[]>("ta/dailyEmails:list", { actorId: user.id, jobId: id }) : [];
  const dailyHistory = dailyEmails.filter(e => e.submissionType === (midday ? "midday" : "eod"));
  const selectedDaily = dailyHistory.find(e => e._id === sp.mail);
  const draft = midday && selectedDaily && selectedDaily.userId === user.id && selectedDaily.date === workdayDate(Date.now()) && ["draft", "failed"].includes(selectedDaily.status) ? selectedDaily : undefined;
  const correction = !midday && sp.revise === "yes" && selectedDaily?.userId === user.id && selectedDaily.status === "accepted" && !selectedDaily.parentId && selectedDaily.snapshot ? selectedDaily : undefined;
  const eodClosed = dailyEmails.some(e => e.userId === user.id && e.date === workdayDate(Date.now()) && e.submissionType === "eod" && e.status === "accepted" && !e.parentId);
  await primeEyeMarked(id, user);
  const o = repo.opening(id);
  if (!o) notFound();

  const client = repo.client(o.clientId);
  if (!client) notFound();

  const director = repo.users().find((u) => u.role === "director");
  const lead = repo.user(o.taLeadId);

  const rows = shortlistRows(id, isTa(user) ? user.id : null, kind);
  const eyeMarked = kind === "director" ? eyeMarkedForEmail(id, user) : [];
  const effort = effortRow(id, user);
  const workType = repo.workingStage(id, user.id);

  // This TA's own sets — each recruiter numbers their own.
  const sets = setsForOpening(id, user.id);
  // The newest one, full or not: a set is closed the moment it has five.
  const latestSet = sets.length ? sets.reduce((a, b) => (b.setNumber > a.setNumber ? b : a)) : undefined;

  // Everyone still waiting on this reviewer, whichever email they went out in.
  const waiting = repo.waitingOn(id, kind);
  const awaiting = waiting.length
    ? repo.reviewRounds(id).filter((r) => r.kind === kind && r.status !== "returned").sort((a, b) => b.sentAt - a.sentAt)[0]
    : undefined;

  const allHistory = repo
    .reviewRounds(id)
    .filter((r) => r.kind === kind && r.status === "returned")
    .sort((a, b) => (b.returnedAt ?? b.sentAt) - (a.returnedAt ?? a.sentAt));
  const matchingHistory = allHistory.filter((r) =>
    matchesQuery(
      sp.q,
      r.replyBody,
      ...r.decisions.map((d) => {
        const app = repo.application(d.applicationId);
        return app ? repo.candidate(app.candidateId)?.fullName : undefined;
      }),
    ),
  );
  const historyPage = pageFrom(sp, matchingHistory.length, PAGE_SIZE);
  const history = slicePage(matchingHistory, historyPage, PAGE_SIZE);

  // The set tonight's CVs went into — the same figure as the SETS column.
  const nextSetNumber = latestSet?.setNumber ?? 1;
  const formattedSubject = rows.length
    ? subjectLine(client.name, o.title, nextSetNumber, rows.length)
    : `${client.name.toUpperCase()} - ${o.title.toUpperCase()} - DAILY ACTIVITY`;

  // The Director's emails sent in the last month, kept to read back and to
  // correct and send again (8 Oct). A TA sees their own; a lead or director
  // sees the desk's.
  const copies =
    kind === "director" ? repo.eodCopies(id).filter((c) => !isTa(user) || c.sentBy === user.id) : [];
  // Opened to read: any version on that list.
  const viewCopy = sp.view ? copies.find((c) => c.id === sp.view) : undefined;
  // Opened to send again: only the sender's own, only inside its month.
  const asked = kind === "director" && sp.resend ? repo.eodCopy(sp.resend) : undefined;
  const resendCopy = asked && asked.openingId === id && asked.sentBy === user.id ? asked : undefined;
  const resendRefused = sp.resend && !resendCopy
    ? asked
      ? "Only the person who sent that email can send it again — it goes from their own mailbox."
      : "That email is more than a month old, so its copy has been cleared."
    : sp.view && !viewCopy
      ? "That email is more than a month old, so its copy has been cleared."
      : null;

  const rawRows = correction?.snapshot?.rows ?? (resendCopy ? resendCopy.rows : rows);
  const candidateIds = rawRows
    .map((r) => r.candidateId ?? repo.application(r.applicationId)?.candidateId)
    .filter(Boolean) as string[];
  if (candidateIds.length > 0) {
    await primeStore({ candidateIds });
  }
  const composerRows: ShortlistRow[] = await Promise.all(
    rawRows.map(async (r) => {
      const app = repo.application(r.applicationId);
      const c = app ? repo.candidate(app.candidateId) : null;
      let pdfSrc = r.pdfSrc ?? null;
      if (!pdfSrc && c && isConvex()) {
        try {
          const cvFile = await backend.cvFile(c.id).catch(() => null);
          if (cvFile?.ok) {
            const cvVersion = cvFile.fileName || c.cvFileName || "1";
            const cvHref = `/api/cv/${encodeURIComponent(c.id)}?app=${encodeURIComponent(r.applicationId)}&v=${encodeURIComponent(cvVersion)}`;
            const isPdf =
              /pdf/i.test(cvFile.fileType ?? "") ||
              /\.pdf$/i.test(cvFile.fileName ?? "") ||
              /\.pdf$/i.test(c.cvFileName ?? "") ||
              !/\.(docx?|rtf|txt|png|jpe?g)$/i.test(cvFile.fileName ?? c.cvFileName ?? "");
            const isWord = !isPdf && isWordFile(cvFile.fileName ?? c.cvFileName);
            if (isPdf || isWord) {
              pdfSrc = isWord ? `${cvHref}&view=pdf` : cvHref;
            }
          }
        } catch {
          // ignore
        }
      }
      return {
        ...r,
        candidateId: c?.id ?? r.candidateId,
        pdfSrc,
      };
    })
  );

  return (
    <div className="mx-auto max-w-[1100px] py-1 sm:px-8 sm:py-9">
      <div className="flex items-center justify-between">
        <Link
          href={`/openings/${id}`}
          className="text-[12.5px] text-ink-soft transition-colors hover:text-ink font-medium"
        >
          ← Back to {o.title}
        </Link>
        <span className="text-[12px] text-ink-faint">
          {kind === "director" ? "Director Review" : "Client Review"}
        </span>
      </div>

      <header className="mb-7 mt-3">
        <h1 className="text-[26px] font-semibold tracking-tight">{midday ? `Midday email${draft ? ` · Email ${draft.number}` : ""}` : "End of Day Submission"}</h1>
        <p className="mt-1.5 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-soft">
          {kind === "director"
            ? `Daily shortlist and effort summary sent to ${EOD_TO}, copying the desk. Add or take off To and Cc addresses below.`
            : `Daily shortlist and effort summary for ${director?.name ?? "the Director"} (${director?.email || "director"}).`}{" "}
          Replies are tracked and candidate stages advance automatically.
        </p>
      </header>


      {/* ── Waiting on a reply ─────────────────────────────────────────── */}
      {awaiting && (
        <section className="mb-6 overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule px-7 py-4">
            <h2 className="text-[13.5px] font-semibold">
              Waiting on {director?.name ?? "the Director"}
            </h2>
            <span className="text-[12px] text-ink-faint">
              {waiting.length} waiting · last sent {timeAt(awaiting.sentAt)}
              {awaiting.trackedAt ? ` · watching ${awaiting.trackedAt}` : ""}
            </span>
          </div>

          <ResearchLine link={awaiting.researchLink} className="border-b border-rule px-7 py-2.5" />

          <ol className="divide-y divide-rule">
            {waiting.map((w, i) => {
              const app = repo.application(w.applicationId);
              const c = app ? repo.candidate(app.candidateId) : null;
              return (
                <li key={w.applicationId} className="flex items-baseline gap-3 px-7 py-2.5">
                  <span className="tabular w-5 shrink-0 text-[12px] text-ink-faint">{i + 1}</span>
                  <span className="flex-1 text-[12.5px] font-medium">{c?.fullName ?? "Unknown"}</span>
                  <span className="text-[12px] text-ink-soft">{app?.setNumber ? `set ${app.setNumber}` : ""}</span>
                </li>
              );
            })}
          </ol>

          <form action={readEodReply} className="border-t border-rule px-7 py-5">
            <input type="hidden" name="openingId" value={id} />
            <input type="hidden" name="kind" value={kind} />
            <label className="block">
              <span className="mb-1.5 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                Their reply
              </span>
              <textarea
                name="reply"
                rows={3}
                placeholder={'Paste the reply. "1, 3 and 5", "shortlist Nimal and Kasun", "2-4" all read correctly.'}
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed"
              />
            </label>
            <div className="mt-2.5 flex flex-wrap items-center gap-3">
              <SubmitButton
                pendingLabel="Reading…"
                className="rounded-full bg-ink px-5 py-2 text-[12.5px] font-medium text-surface disabled:opacity-60"
              >
                Read it and move them
              </SubmitButton>
              <span className="text-[11.5px] text-ink-faint">
                Anyone the reply picks is shortlisted, and the rest of that email are marked not
                selected. If part of the reply cannot be read, nobody is marked not selected.
              </span>
            </div>
          </form>
        </section>
      )}

      {/* A reply landed in the shared box and does not obviously belong to the
          set on this screen — or to this opening at all. Given the sender and
          the subject it finds its own round. */}
      <details className="mb-6 rounded-2xl border border-rule bg-surface">
        <summary className="cursor-pointer px-7 py-4 text-[13px] font-medium">
          A reply came into {repo.shortlistInbox()} — place it for me
        </summary>
        <form action={readInboundReply} className="border-t border-rule px-7 py-5">
          <input type="hidden" name="openingId" value={id} />
          <input type="hidden" name="kind" value={kind} />
          {/* The action checks this to refuse a CV that wandered into the
              shortlist box. It was reading a field the form never sent, so the
              check could never fire. */}
          <input type="hidden" name="to" value={repo.shortlistInbox()} />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                From
              </span>
              <input
                name="from"
                placeholder="director@career141.com"
                className="w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                Subject
              </span>
              <input
                name="subject"
                placeholder={subjectLine(client.name, o.title, nextSetNumber)}
                className="w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]"
              />
            </label>
          </div>
          <textarea
            name="reply"
            rows={3}
            placeholder="What they wrote."
            className="mt-3 w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <SubmitButton
              tone="dark"
              pendingLabel="Applying…"
              className="rounded-full border border-rule-strong px-5 py-2 text-[12.5px] font-medium disabled:opacity-60"
            >
              Find the set and apply it
            </SubmitButton>
            <span className="max-w-[62ch] text-[11.5px] text-ink-faint">
              The subject says which opening, the sender says whether it is the Director or the
              client. It searches every open round, not just this opening&rsquo;s — and refuses
              rather than guessing when either is missing.
            </span>
          </div>
        </form>
      </details>

      {kind === "director" && <DailyEmailHistory emails={dailyHistory} openingId={id} />}
      {midday && <form action={addMiddayEmail} className="mb-5">
        <input type="hidden" name="openingId" value={id} />
        <SubmitButton disabled={eodClosed} pendingLabel="Adding…" className="rounded-lg bg-brand px-4 py-2 text-white disabled:opacity-40">Add midday email</SubmitButton>
      </form>}
      {eodClosed && !correction && <p className="mb-5 text-sm">End of day has been sent. You can read your sent emails or correct the original EOD email. New submissions resume tomorrow.</p>}
      {selectedDaily && !draft && !correction && <DailyEmailView email={selectedDaily} openingId={id} canCorrect={selectedDaily.userId === user.id} canReconcile={["ta_lead", "admin"].includes(user.role)} />}
      {!midday && copies.length > 0 && (
        <SentHistory copies={copies} user={user} openingId={id} openId={resendCopy?.id} viewId={viewCopy?.id} />
      )}

      {viewCopy && <SentEmail copy={viewCopy} openingId={id} />}

      {resendRefused && (
        <p className="mb-6 rounded-xl bg-warn-soft px-5 py-3 text-[12.5px] text-warn">{resendRefused}</p>
      )}

      {resendCopy && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[14px] font-semibold">
            Correcting the email sent {timeAt(resendCopy.sentAt)}
          </h2>
          <Link href={`/openings/${id}/eod?kind=director`} className="text-[12.5px] text-ink-soft hover:text-ink">
            Cancel — back to a new email
          </Link>
        </div>
      )}

      {/* ── Email Composer (for sending next set, or correcting one sent) ── */}
      {(!midday || !!draft) && (!selectedDaily || !!draft || !!correction) && (!eodClosed || !!correction || !!resendCopy) && <>
      {!midday && <LiveTableRefresh />}
      {!midday && workType === "100%" && <EyeMarkedChecks openingId={id} items={eyeMarked} />}
      <EodComposer
        key={draft?._id ?? correction?._id ?? resendCopy?.id ?? "new"}
        submissionType={midday ? "midday" : "eod"}
        dailyDraft={draft ? { id: draft._id, revision: draft.revision, fields: draft.fields } : undefined}
        dailyParentId={correction?._id}
        openingId={id}
        kind={kind}
        subject={correction?.snapshot ? revisedSubject(correction.snapshot.subject) : resendCopy ? revisedSubject(resendCopy.subject) : midday ? `MIDDAY ${draft?.number ?? 1} - ${workdayDate(Date.now())} - ${formattedSubject}` : formattedSubject}
        toName={kind === "director" ? "Job Orders" : (director?.name ?? "Director")}
        toEmail={kind === "director" ? EOD_TO : (director?.email ?? "")}
        ccName={kind === "director" ? "" : (lead?.name ?? "")}
        ccEmail={kind === "director" ? "" : (lead?.email ?? "")}
        trackedAt={repo.shortlistInbox()}
        eodCc={null}
        fixedCc={kind === "director" ? [...EOD_CC_DEFAULTS] : []}
        canAddRecipients={kind === "director"}
        rows={composerRows}
        effort={correction?.snapshot?.effort ?? (resendCopy ? resendCopy.effort : effort)}
        senderName={user.name}
        alreadyOut={!!awaiting}
        needsResearchLink={midday || needsResearchLink(user.role, kind, workType)}
        workType={workType}
        resend={
          correction?.snapshot ? { copyId: correction._id, introText: correction.snapshot.introText, outroText: correction.snapshot.outroText,
            researchLink: correction.snapshot.researchLink, extraTo: correction.snapshot.extraTo, extraCc: correction.snapshot.extraCc, removed: correction.snapshot.removed } : resendCopy
            ? {
                copyId: resendCopy.id,
                introText: resendCopy.introText,
                outroText: resendCopy.outroText,
                researchLink: resendCopy.researchLink,
                extraTo: resendCopy.extraTo,
                extraCc: resendCopy.extraCc,
                removed: resendCopy.removed,
              }
            : undefined
        }
        openSetNote={
          latestSet
            ? latestSet.status === "closed"
              ? `Set ${latestSet.setNumber} is complete with ${latestSet.count} CVs. Set ${latestSet.setNumber + 1} starts the next day you shortlist.`
              : `Set ${latestSet.setNumber} has ${latestSet.count} ${latestSet.count === 1 ? "CV" : "CVs"} so far. It is complete on a day you send ${SET_SIZE} or more.`
            : null
        }
      />
      </>}

      {/* ── Email Replies & Review History ──────────────────────────────── */}
      {history.length > 0 && (
        <section className="mt-9">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-ink">Replies Received for this Role</h2>
            <span className="text-[12px] text-ink-faint">{allHistory.length} email(s) logged</span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-sm divide-y divide-rule">
            {history.map((r) => {
              const shortlisted = r.decisions
                .filter((d) => d.outcome === "shortlisted")
                .map((d) => {
                  const app = repo.application(d.applicationId);
                  return app ? repo.candidate(app.candidateId) : null;
                })
                .filter(Boolean);

              return (
                <div key={r.id} className="p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">
                        {r.setNumber ? `Set ${r.setNumber}` : "Review Round"}
                      </span>
                      <span className="text-ink-faint">·</span>
                      <span className="text-ink-soft">{r.returnedAt ? timeAt(r.returnedAt) : timeAt(r.sentAt)}</span>
                    </div>

                    {shortlisted.length > 0 ? (
                      <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                        {shortlisted.length} shortlisted
                      </span>
                    ) : (
                      <span className="rounded-full bg-stone-500/10 px-2.5 py-0.5 text-[11px] font-medium text-stone-600 dark:text-stone-300">
                        No candidates selected
                      </span>
                    )}
                  </div>

                  <ResearchLine link={r.researchLink} className="mt-3" />

                  {r.replyBody && (
                    <div className="mt-3 rounded-lg bg-tag/60 px-3.5 py-2 text-[12.5px] text-ink-soft">
                      <span className="font-medium text-ink">{kind === "director" ? "Director" : "Client"} reply: </span>
                      &ldquo;{extractReplyText(r.replyBody)}&rdquo;
                    </div>
                  )}

                  {shortlisted.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {shortlisted.map((c) => (
                        <span
                          key={c!.id}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[12px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
                        >
                          ✓ Shortlisted: {c!.fullName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Pager page={historyPage} pageSize={PAGE_SIZE} total={matchingHistory.length} href={pageLink(`/openings/${id}/eod`, sp)} />
        </section>
      )}
    </div>
  );
}

/** How many emails the history shows before the rest fold away. */
const HISTORY_SHOWN = 8;

/**
 * The Director's emails sent in the last month (8 Oct), each with its
 * versions. Any version opens to read as it went; the sender can correct the
 * newest and send it again when the TA Lead or a Director asks. Once the month
 * is over the copies are deleted and the email drops off this list; the round
 * and its reply stay on the page as before.
 */
function SentHistory({
  copies,
  user,
  openingId,
  openId,
  viewId,
}: {
  copies: EodEmailCopy[];
  user: User;
  openingId: string;
  openId?: string;
  viewId?: string;
}) {
  // One entry per email, newest version first within it, newest email first.
  const byRound = new Map<string, EodEmailCopy[]>();
  for (const c of copies) byRound.set(c.roundId, [...(byRound.get(c.roundId) ?? []), c]);
  const emails = [...byRound.values()]
    .map((v) => v.sort((a, b) => b.version - a.version))
    .sort((a, b) => b[0].sentAt - a[0].sentAt);

  const entry = (versions: EodEmailCopy[]) => {
    const latest = versions[0];
    const first = versions[versions.length - 1];
    const mine = latest.sentBy === user.id;
    // A lead reads the desk's emails, so each says whose it is.
    const sender = isTa(user) ? null : repo.user(latest.sentBy)?.name;
    return (
      <li key={latest.roundId} className="px-7 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium">{latest.subject}</p>
            <p className="mt-0.5 text-[12px] text-ink-soft">
              {sender ? `${sender} · ` : ""}
              {latest.rows.length} {latest.rows.length === 1 ? "CV" : "CVs"} · to {latest.to.join(", ")}
              {latest.cc.length ? ` · cc ${latest.cc.join(", ")}` : ""}
            </p>
          </div>
          {mine &&
            (openId === latest.id ? (
              <span className="text-[12px] text-ink-faint">Open below</span>
            ) : (
              <Link
                href={`/openings/${openingId}/eod?kind=director&resend=${latest.id}`}
                className="shrink-0 rounded-full border border-brand px-4 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand hover:text-white"
              >
                Edit and send again
              </Link>
            ))}
        </div>
        <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
          {[...versions].reverse().map((v) => (
            <li key={v.id}>
              {v.version === 1 ? "Sent" : `Revised (${v.version - 1})`} {timeAt(v.sentAt)} ·{" "}
              {viewId === v.id ? (
                <span className="text-ink-soft">open below</span>
              ) : (
                <Link href={`/openings/${openingId}/eod?kind=director&view=${v.id}`} className="text-brand hover:underline">
                  Read
                </Link>
              )}
            </li>
          ))}
          <li>· Copy deleted {timeAt(first.expiresAt)}</li>
        </ol>
      </li>
    );
  };

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule px-7 py-4">
        <h2 className="text-[13.5px] font-semibold">
          Sent emails <span className="ml-1.5 text-[12px] font-normal text-ink-faint">{emails.length}</span>
        </h2>
        <span className="text-[12px] text-ink-faint">Kept for a month to read, correct and send again, then deleted.</span>
      </div>
      <ul className="divide-y divide-rule">{emails.slice(0, HISTORY_SHOWN).map(entry)}</ul>
      {emails.length > HISTORY_SHOWN && (
        <details className="border-t border-rule">
          <summary className="cursor-pointer px-7 py-3 text-[12.5px] text-ink-soft hover:text-ink">
            {emails.length - HISTORY_SHOWN} older {emails.length - HISTORY_SHOWN === 1 ? "email" : "emails"}
          </summary>
          <ul className="divide-y divide-rule border-t border-rule">{emails.slice(HISTORY_SHOWN).map(entry)}</ul>
        </details>
      )}
    </section>
  );
}

/**
 * One version of a sent email, as it went: the same HTML the email carried
 * (lib/eod-format eodEmailHtml), in a sandboxed frame so nothing in it can run
 * or reach the page. The CVs are listed by name; the stamped files are not kept.
 */
function SentEmail({ copy, openingId }: { copy: EodEmailCopy; openingId: string }) {
  const sender = repo.user(copy.sentBy);
  const html = eodEmailHtml({
    rows: copy.rows,
    effort: copy.effort,
    senderName: sender?.name ?? "",
    introText: copy.introText,
    outroText: copy.outroText,
    researchLink: copy.researchLink,
  });
  const line = (label: string, value: string) => (
    <div className="flex gap-3">
      <span className="w-[52px] shrink-0 text-ink-faint">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule px-7 py-4">
        <h2 className="text-[13.5px] font-semibold">
          {copy.version === 1 ? "Sent" : `Revised (${copy.version - 1})`} {timeAt(copy.sentAt)}
        </h2>
        <Link href={`/openings/${openingId}/eod?kind=director`} className="text-[12.5px] text-ink-soft hover:text-ink">
          Close
        </Link>
      </div>
      <div className="flex flex-col gap-1.5 border-b border-rule px-7 py-4 text-[12.5px]">
        {line("From", sender ? `${sender.name} · ${sender.email}` : "—")}
        {line("To", copy.to.join(", ") || "—")}
        {line("Cc", copy.cc.join(", ") || "Nobody")}
        {line("Subject", copy.subject)}
        {line("CVs", copy.rows.map((r) => `${r.name} - Career141.pdf`).join(", ") || "None")}
      </div>
      <iframe
        title={`The email sent ${timeAt(copy.sentAt)}`}
        sandbox=""
        srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:16px 28px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#171c18;background:#fff">${html}</body>`}
        className="block h-[560px] w-full bg-white"
      />
    </section>
  );
}

/**
 * The research link the TA sent with this round (8 Oct), for the TA leads and
 * directors who want to open it from the platform as well as from the email.
 * Rounds sent before the field existed, and the client copy, have none: nothing
 * is shown. Checked again here, so only a share link is ever an address.
 */
function ResearchLine({ link, className }: { link?: string | null; className?: string }) {
  const checked = link ? validateResearchLink(link) : null;
  if (!checked?.ok) return null;
  return (
    <p className={`text-[12px] ${className ?? ""}`}>
      <span className="text-ink-faint">Research: </span>
      <a href={checked.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
        View ChatGPT Research
      </a>
    </p>
  );
}
