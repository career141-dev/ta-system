import Link from "next/link";
import { repo } from "@/data/store";
import { computeAlerts } from "@/lib/sla";
import { relDays } from "@/lib/format";

/**
 * Ops — spec §13 and notebook page 9, which routes the client-review chase here
 * specifically rather than to a generic flag. This screen is a chasing list.
 */
export function OpsDashboard({ opsId }: { opsId: string }) {
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

  return (
    <>
      <section className="mb-8 grid gap-4 sm:grid-cols-3">
        {[
          { n: withClient.length, label: "Sitting with clients" },
          { n: mine.length, label: "To chase", warn: mine.length > 0 },
          { n: interviews.length, label: "Interviews scheduled" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-rule bg-surface px-6 py-5">
            <div className={`tabular text-[26px] font-semibold leading-none ${s.warn ? "text-warn" : ""}`}>
              {s.n}
            </div>
            <div className="mt-2 text-[12.5px] text-ink-soft">{s.label}</div>
          </div>
        ))}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">Waiting on client feedback</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            {withClient.length === 0 ? (
              <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">
                Nothing with a client.
              </p>
            ) : (
              <div className="divide-y divide-rule">
                {withClient.map(({ o, a }) => {
                  const c = repo.candidate(a.candidateId);
                  const waiting = Math.floor((Date.now() - a.lastStageChangedAt) / 86_400_000);
                  return (
                    <Link
                      key={a.id}
                      href={`/openings/${o.id}/pipeline/client_shortlist`}
                      className="flex flex-wrap items-center gap-x-5 gap-y-1 px-7 py-3.5 hover:bg-paper/60"
                    >
                      <div className="min-w-[200px] flex-1">
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
        </section>

        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">Interviews to coordinate</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            {interviews.length === 0 ? (
              <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">
                Nothing scheduled.
              </p>
            ) : (
              <div className="divide-y divide-rule">
                {interviews.map((iv) => {
                  const a = repo.application(iv.applicationId);
                  const c = a ? repo.candidate(a.candidateId) : null;
                  const o = a ? repo.opening(a.openingId) : null;
                  const confirmed = a
                    ? repo
                        .callFeedback(a.id)
                        .some((f) => f.kind === "pre_interview" && f.outcome === "reached")
                    : false;
                  return (
                    <div key={iv.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-7 py-3.5">
                      <div className="min-w-[200px] flex-1">
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
        </section>
      </div>

      {mine.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3.5 text-[13px] font-semibold">Assigned to you</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            <div className="divide-y divide-rule">
              {mine.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-7 py-4">
                  <p className="min-w-[260px] flex-1 text-[13.5px]">{a.detail}</p>
                  <Link
                    href={a.href}
                    className="rounded-full border border-brand-line px-3.5 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
                  >
                    {a.action}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
