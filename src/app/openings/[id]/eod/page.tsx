import Link from "next/link";
import { notFound } from "next/navigation";
import { repo, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { EodComposer } from "@/components/EodComposer";
import { effortRow, shortlistRows, subjectLine } from "@/lib/eod";
import { readEodReply, readInboundReply } from "@/app/actions";
import { timeAt } from "@/lib/format";
import { primeStore } from "@/data/prime";

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
  searchParams: Promise<{ kind?: string; msg?: string }>;
}) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const kind = "director" as const;
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
  const history = repo.reviewRounds(id).filter((r) => r.kind === kind && r.status === "returned");

  return (
    <main className="mx-auto max-w-[1100px] px-8 py-9">
      <Link
        href={`/openings/${id}`}
        className="text-[12.5px] text-ink-soft transition-colors hover:text-ink"
      >
        ← {o.title}
      </Link>

      <header className="mb-6 mt-3">
        <h1 className="text-[26px] font-semibold tracking-tight">End of day</h1>
        <p className="mt-2 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-soft">
          Sent from your own mailbox to {director?.name ?? "the Director"}, copying{" "}
          {lead?.name ?? "the TA Lead"}. When the reply comes back, paste it below — whoever he
          picks moves to the Director shortlist on its own.
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
              <button className="rounded-full bg-ink px-5 py-2 text-[12.5px] font-medium text-surface">
                Read it and move them
              </button>
              <span className="text-[11.5px] text-ink-faint">
                Anyone the reply names is moved. Anyone it does not mention stays where they are —
                nobody is moved on a guess.
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
                placeholder={subjectLine(client.name, o.title)}
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
            <button className="rounded-full border border-rule-strong px-5 py-2 text-[12.5px] font-medium">
              Find the set and apply it
            </button>
            <span className="max-w-[62ch] text-[11.5px] text-ink-faint">
              The subject says which opening, the sender says whether it is the Director or the
              client. It searches every open round, not just this opening&rsquo;s — and refuses
              rather than guessing when either is missing.
            </span>
          </div>
        </form>
      </details>

      <EodComposer
        openingId={id}
        kind={kind}
        subject={subjectLine(client.name, o.title)}
        toName={director?.name ?? "Director"}
        toEmail={director?.email ?? ""}
        ccName={lead?.name ?? ""}
        ccEmail={lead?.email ?? ""}
        /* Copied in and named on the reply-to, so the reply is caught whether
           they press Reply or Reply All. */
        trackedAt={repo.shortlistInbox()}
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

      {history.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-[13.5px] font-semibold">Replies already in</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            <div className="divide-y divide-rule">
              {history.map((r) => (
                <div key={r.id} className="px-7 py-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 text-[12px] text-ink-faint">
                    <span>{r.returnedAt ? timeAt(r.returnedAt) : ""}</span>
                    <span>
                      {r.decisions.filter((d) => d.outcome === "shortlisted").length} shortlisted ·{" "}
                      {r.decisions.filter((d) => d.outcome === "rejected").length} passed
                    </span>
                  </div>
                  {r.replyBody && (
                    <p className="mt-1 text-[12.5px] italic text-ink-soft">
                      &ldquo;{r.replyBody.slice(0, 220)}
                      {r.replyBody.length > 220 ? "…" : ""}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
