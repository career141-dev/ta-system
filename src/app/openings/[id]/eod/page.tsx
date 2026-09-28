import Link from "next/link";
import { notFound } from "next/navigation";
import { repo, setsForOpening, SET_SIZE } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { EodComposer } from "@/components/EodComposer";
import { effortRow, shortlistRows, subjectLine } from "@/lib/eod";
import { readEodReply, readInboundReply } from "@/app/actions";
import { SubmitButton } from "@/components/Submit";
import { timeAt } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { requireSourcingSeat } from "../sourcingGate";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";
import { extractReplyText } from "@/lib/reviewReply";

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
  searchParams: Promise<{ kind?: string; msg?: string; q?: string; page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);
  const kind: "director" | "client" = sp.kind === "client" ? "client" : "director";
  const user = await getCurrentUser();
  const o = repo.opening(id);
  if (!o) notFound();

  const client = repo.client(o.clientId);
  if (!client) notFound();

  const director = repo.users().find((u) => u.role === "director");
  const lead = repo.user(o.taLeadId);

  const rows = shortlistRows(id, user.role === "ta" ? user.id : null, kind);
  const effort = effortRow(id, user);

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
  const formattedSubject = subjectLine(client.name, o.title, nextSetNumber, rows.length || 1);

  return (
    <main className="mx-auto max-w-[1100px] px-8 py-9">
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
        <h1 className="text-[26px] font-semibold tracking-tight">End of Day Submission</h1>
        <p className="mt-1.5 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-soft">
          Daily shortlist and effort summary sent to {director?.name ?? "the Director"} ({director?.email || "director"}).
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
          <div className="grid gap-3 sm:grid-cols-2">
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

      {/* ── Email Composer (for sending next set) ────────────────────────── */}
      <EodComposer
        openingId={id}
        kind={kind}
        subject={formattedSubject}
        toName={director?.name ?? "Director"}
        toEmail={director?.email ?? ""}
        ccName={lead?.name ?? ""}
        ccEmail={lead?.email ?? ""}
        trackedAt={repo.shortlistInbox()}
        eodCc={kind === "director" ? repo.eodCopyTo() : null}
        rows={rows}
        effort={effort}
        senderName={user.name}
        alreadyOut={!!awaiting}
        openSetNote={
          latestSet
            ? latestSet.status === "closed"
              ? `Set ${latestSet.setNumber} is complete with ${latestSet.count} CVs. Set ${latestSet.setNumber + 1} starts the next day you shortlist.`
              : `Set ${latestSet.setNumber} has ${latestSet.count} ${latestSet.count === 1 ? "CV" : "CVs"} so far. It is complete on a day you send ${SET_SIZE} or more.`
            : null
        }
      />

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
                      <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
                        {shortlisted.length} shortlisted
                      </span>
                    ) : (
                      <span className="rounded-full bg-stone-500/10 px-2.5 py-0.5 text-[11px] font-medium text-stone-600">
                        No candidates selected
                      </span>
                    )}
                  </div>

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
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[12px] font-medium text-emerald-800"
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
    </main>
  );
}
