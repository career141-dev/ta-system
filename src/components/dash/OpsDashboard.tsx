import Link from "next/link";
import { repo } from "@/data/store";
import { computeAlerts } from "@/lib/sla";
import { colomboDaysBetween, relDays } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageOf, type Params } from "@/lib/paging";

/**
 * Ops — spec §13 and notebook page 9, which routes the client-review chase here
 * specifically rather than to a generic flag. This screen is a chasing list.
 */
export function OpsDashboard({ opsId, sp = {} }: { opsId: string; sp?: Params }) {
  const q = typeof sp.q === "string" ? sp.q : "";
  const mine = computeAlerts().filter((a) => a.assignedTo.includes(opsId));
  const open = repo.openings().filter((o) => o.status === "open");

  const withClient = open.flatMap((o) =>
    repo
      .applications(o.id)
      .filter((a) => a.stage === "client_shortlist")
      .map((a) => ({ o, a })),
  );

  const interviews = repo
    .interviews()
    .filter((i) => i.outcome === "pending")
    .sort((a, b) => a.scheduledAt - b.scheduledAt);

  // The header search narrows the lists; the counts above stay whole.
  const clientList = pageOf(
    withClient.filter(({ o, a }) => matchesQuery(q, repo.candidate(a.candidateId)?.fullName, o.title, repo.client(o.clientId)?.name)),
    sp, "spage", 10, "/",
  );
  const interviewList = pageOf(
    interviews.filter((iv) => {
      const a = repo.application(iv.applicationId);
      return matchesQuery(q, a ? repo.candidate(a.candidateId)?.fullName : undefined, a ? repo.opening(a.openingId)?.title : undefined);
    }),
    sp, "ipage", 10, "/",
  );
  const chaseList = pageOf(mine.filter((a) => matchesQuery(q, a.detail, a.action)), sp, "apage", 10, "/");

  return (
    <>
      <section className="mb-7 grid grid-cols-3 gap-2 sm:mb-8 sm:gap-4">
        {[
          { n: withClient.length, label: "Sitting with clients" },
          { n: mine.length, label: "To chase", warn: mine.length > 0 },
          { n: interviews.length, label: "Interviews scheduled" },
        ].map((s) => (
          <div key={s.label} className="min-w-0 rounded-2xl border border-rule bg-surface px-2.5 py-4 sm:px-6 sm:py-5">
            <div className={`tabular truncate text-[21px] font-semibold leading-none sm:text-[26px] ${s.warn ? "text-warn" : ""}`}>
              {s.n}
            </div>
            <div className="mt-2 text-[11px] leading-tight text-ink-soft min-[400px]:text-[12px] sm:text-[12.5px]">{s.label}</div>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-7 sm:gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">Waiting on client feedback</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            {clientList.pager.total === 0 ? (
              <p className="px-4 sm:px-7 py-10 text-center text-[12.5px] text-ink-faint">
                {q ? "Nothing here matches that search." : "Nothing with a client."}
              </p>
            ) : (
              <div className="divide-y divide-rule">
                {clientList.rows.map(({ o, a }) => {
                  const c = repo.candidate(a.candidateId);
                  const waiting = colomboDaysBetween(a.lastStageChangedAt);
                  return (
                    <Link
                      key={a.id}
                      href={`/openings/${o.id}/pipeline/client_shortlist`}
                      className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3.5 active:bg-paper/60 sm:flex sm:flex-wrap sm:gap-x-5 sm:px-7 sm:hover:bg-paper/60"
                    >
                      <div className="min-w-0 sm:min-w-[200px] sm:flex-1">
                        <p className="text-[13.5px] font-medium">{c?.fullName}</p>
                        <p className="text-[11.5px] text-ink-faint">
                          {repo.client(o.clientId)?.name} · {o.title}
                        </p>
                      </div>
                      <span
                        className={`text-[12px] ${waiting >= 1 ? "text-warn" : "text-ink-soft"}`}
                      >
                        {waiting === 0 ? "today" : `${waiting}d with the client`}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
          <Pager {...clientList.pager} scroll={false} className="mt-4" />
        </section>

        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">Interviews to coordinate</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            {interviewList.pager.total === 0 ? (
              <p className="px-4 sm:px-7 py-10 text-center text-[12.5px] text-ink-faint">
                {q ? "Nothing here matches that search." : "Nothing scheduled."}
              </p>
            ) : (
              <div className="divide-y divide-rule">
                {interviewList.rows.map((iv) => {
                  const a = repo.application(iv.applicationId);
                  const c = a ? repo.candidate(a.candidateId) : null;
                  const o = a ? repo.opening(a.openingId) : null;
                  const confirmed = a
                    ? repo
                        .callFeedback(a.id)
                        .some((f) => f.kind === "pre_interview" && f.outcome === "reached")
                    : false;
                  return (
                    <div key={iv.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3.5 sm:flex sm:flex-wrap sm:gap-x-5 sm:px-7">
                      <div className="min-w-0 sm:min-w-[200px] sm:flex-1">
                        <p className="text-[13.5px] font-medium">{c?.fullName}</p>
                        <p className="text-[11.5px] text-ink-faint">
                          {o?.title} · {new Date(iv.scheduledAt).toLocaleString("en-GB", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      <span className={`text-[12px] ${confirmed ? "text-ink-soft" : "text-danger"}`}>
                        {confirmed ? "Confirmed" : "Not contacted"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <Pager {...interviewList.pager} scroll={false} className="mt-4" />
        </section>
      </div>

      {chaseList.pager.total > 0 && (
        <section className="mt-8">
          <h2 className="mb-3.5 text-[13px] font-semibold">Assigned to you</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            <div className="divide-y divide-rule">
              {chaseList.rows.map((a) => (
                <div key={a.id} className="grid grid-cols-1 gap-3 px-4 py-4 sm:flex sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2 sm:px-7">
                  <p className="min-w-0 text-[13.5px] sm:min-w-[260px] sm:flex-1">{a.detail}</p>
                  <Link
                    href={a.href}
                    className="flex min-h-11 items-center justify-center rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors active:bg-brand-soft sm:min-h-0 sm:px-3.5 sm:py-1.5 sm:hover:bg-brand-soft"
                  >
                    {a.action}
                  </Link>
                </div>
              ))}
            </div>
          </div>
          <Pager {...chaseList.pager} scroll={false} className="mt-4" />
        </section>
      )}
    </>
  );
}
