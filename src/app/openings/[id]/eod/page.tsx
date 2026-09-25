import Link from "next/link";
import { notFound } from "next/navigation";
import { repo, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { EodComposer } from "@/components/EodComposer";
import { effortRow, shortlistRows, subjectLine } from "@/lib/eod";
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
  const openSet = sets.find((s) => s.status === "open");

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

  // Determine the set number for today's submission
  const nextSetNumber = openSet?.setNumber ?? (sets.length ? Math.max(...sets.map((s) => s.setNumber)) + 1 : 1);
  const formattedSubject = subjectLine(o.title, nextSetNumber, rows.length || 1);

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
          openSet
            ? openSet.count >= 5
              ? `This is set ${openSet.setNumber}, at ${openSet.count}. It has reached five, so tomorrow starts set ${openSet.setNumber + 1}.`
              : `This is set ${openSet.setNumber}, at ${openSet.count}. It goes as it is and carries on as set ${openSet.setNumber} tomorrow.`
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
                      <span className="font-medium text-ink">Director Reply: </span>
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
