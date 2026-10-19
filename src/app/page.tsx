import Link from "next/link";
import { colomboGreeting } from "@/lib/calendar";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { PRIORITY_TARGET } from "@/data/types";
import { colomboDaysBetween, inHours, relDays } from "@/lib/format";
import { alertsFor } from "@/lib/sla";
import { LeadDashboard } from "@/components/dash/LeadDashboard";
import { DirectorDashboard } from "@/components/dash/DirectorDashboard";
import { OpsDashboard } from "@/components/dash/OpsDashboard";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageOf, type Params } from "@/lib/paging";
import { linkedinStatus } from "@/lib/linkedinStatus";
import { LinkedInPill } from "@/components/LinkedInPill";

/**
 * The day, not the database. What is urgent, what is scheduled, what each of my
 * openings needs from me next — and nothing about the agency as a whole, which
 * is the Director's view, not a recruiter's.
 */
export default async function Dashboard({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  await primeStore({ allApplications: true, followUps: true });
  const user = await getCurrentUser();
  const openings = repo.openingsForUser(user).filter((o) => o.status === "open");
  const alerts = alertsFor(user.id);
  const urgent = alerts.filter((a) => a.urgent);
  const routine = alerts.filter((a) => !a.urgent);
  const clients = repo.clients();

  const interviews = repo
    .interviews()
    .filter((i) => i.outcome === "pending" && i.scheduledAt > Date.now())
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, 5);

  const greeting = colomboGreeting();

  // Spec §13 — four different jobs, four different screens.
  if (user.role === "ta_lead" || user.role === "admin") {
    return (
      <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-8 sm:py-9">
        <header className="mb-6 sm:mb-8">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-[24px]">
            {greeting}, {user.name}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            {openings.length} open across the team
            {urgent.length > 0 && ` · ${urgent.length} urgent`}
          </p>
        </header>
        <LeadDashboard leadId={user.id} sp={sp} />
      </main>
    );
  }

  if (user.role === "director") {
    return (
      <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-8 sm:py-9">
        <header className="mb-6 sm:mb-8">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-[24px]">
            {greeting}, {user.name}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-soft">Agency-wide</p>
        </header>
        <DirectorDashboard sp={sp} />
      </main>
    );
  }

  if (user.role === "ops") {
    return (
      <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-8 sm:py-9">
        <header className="mb-6 sm:mb-8">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-[24px]">
            {greeting}, {user.name}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-soft">Chasing and coordination</p>
        </header>
        <OpsDashboard opsId={user.id} sp={sp} />
      </main>
    );
  }

  // The TA's own view: the header search narrows the lists, each pages on its own.
  const urgentList = pageOf(urgent.filter((a) => matchesQuery(q, a.detail, a.kind.replace(/_/g, " "))), sp, "upage", 10, "/");
  const myOpenings = pageOf(
    openings.filter((o) => matchesQuery(q, o.title, clients.find((c) => c.id === o.clientId)?.name)),
    sp,
    "opage",
    10,
    "/",
  );

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-8 sm:py-9">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-[24px]">
          {greeting}, {user.name}
        </h1>
        <p className="mt-1.5 text-[13px] text-ink-soft">
          {openings.length} open {openings.length === 1 ? "role" : "roles"}
          {urgent.length > 0 && ` · ${urgent.length} needing attention now`}
          {interviews.length > 0 && ` · ${interviews.length} interviews ahead`}
        </p>
      </header>

      {urgentList.pager.total > 0 && (
        <section className="mb-7 overflow-hidden rounded-xl border border-rule bg-surface sm:mb-8">
          <h2 className="border-b border-rule px-4 py-3.5 text-[13px] font-semibold sm:px-7 sm:py-4">
            Today, in order
          </h2>
          <div className="divide-y divide-rule">
            {urgentList.rows.map((a) => (
              <div key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 px-4 py-4 sm:flex sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2 sm:px-7">
                <div className="min-w-0 sm:min-w-[260px] sm:flex-1">
                  <p className="text-[13.5px]">{a.detail}</p>
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">
                    {a.kind.replace(/_/g, " ")}
                  </p>
                </div>
                <span className="tabular whitespace-nowrap text-[12.5px] text-ink-soft">{inHours(a.dueAt)}</span>
                <Link
                  href={a.href}
                  className="col-span-2 flex min-h-11 items-center justify-center rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand active:bg-brand-soft sm:col-span-1 sm:min-h-0 sm:px-3.5 sm:py-1.5 sm:hover:bg-brand-soft"
                >
                  {a.action}
                </Link>
              </div>
            ))}
          </div>
          <Pager {...urgentList.pager} scroll={false} className="border-t border-rule py-4" />
        </section>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-7 sm:gap-8 lg:grid-cols-[1fr_300px]">
        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">My openings</h2>
          <div className="flex flex-col gap-4">
            {myOpenings.pager.total === 0 && (
              <div className="rounded-xl border border-rule bg-surface px-4 py-12 text-center text-[13px] text-ink-faint sm:px-7 sm:py-14">
                {q && openings.length > 0 ? "None of your openings match that search." : "Nothing assigned to you."}
              </div>
            )}
            {myOpenings.rows.map((o) => {
              const client = clients.find((c) => c.id === o.clientId);
              const counts = stageCounts(o.id);
              const sets = setsForOpening(o.id);
              const openSet = sets.find((s) => s.status === "open");
              const posts = repo.jobPosts(o.id);
              const live = posts.filter((j) => j.status === "live");
              const cvsToday = live.reduce((n, j) => n + j.cvCountToday, 0);
              const days = o.assignedAt ? colomboDaysBetween(o.assignedAt) : 0;
              const target = PRIORITY_TARGET[o.priorityTier].days;

              const need =
                o.jdStatus === "pending_ta_approval"
                  ? "The JD is waiting for your approval"
                  : cvsToday < 10
                    ? `Only ${cvsToday} CVs today — under the ten a day line`
                    : openSet
                      ? `Set ${openSet.setNumber} needs ${5 - openSet.count} more to close`
                      : "On track";

              return (
                <Link
                  key={o.id}
                  href={`/openings/${o.id}`}
                  className="rounded-xl border border-rule bg-surface px-4 py-4 active:border-rule-strong active:bg-paper/40 sm:px-7 sm:py-5 sm:hover:border-rule-strong"
                >
                  <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-5">
                    <div className="min-w-0">
                      <p className="text-[12px] text-ink-faint">{client?.name}</p>
                      <p className="mt-0.5 text-[15.5px] font-semibold tracking-tight">{o.title}</p>
                      {/* Whether LinkedIn applications reach this job, without opening it (30 Sep). */}
                      <div className="mt-2">
                        <LinkedInPill status={linkedinStatus(posts)} />
                      </div>
                    </div>
                    <div className="grid w-full grid-cols-3 gap-2 rounded-lg bg-paper p-3 text-left sm:w-auto sm:rounded-none sm:bg-transparent sm:p-0 sm:text-right">
                      <div>
                        <div className="tabular text-[16px] font-semibold leading-none">
                          {(counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0)}
                        </div>
                        <div className="mt-1.5 text-[11.5px] text-ink-soft">Follow-up</div>
                      </div>
                      <div>
                        <div className={`tabular text-[16px] font-semibold leading-none ${cvsToday < 10 ? "text-danger" : ""}`}>
                          {cvsToday}
                        </div>
                        <div className="mt-1.5 text-[11.5px] text-ink-soft">CVs today</div>
                      </div>
                      <div>
                        <div className={`tabular text-[16px] font-semibold leading-none ${days > target ? "text-danger" : ""}`}>
                          {days}
                        </div>
                        <div className="mt-1.5 text-[11.5px] text-ink-soft">of {target} days</div>
                      </div>
                    </div>
                  </div>
                  <p className="mt-4 border-t border-rule pt-3.5 text-[12.5px] text-ink-soft">
                    {need}
                  </p>
                </Link>
              );
            })}
          </div>
          <Pager {...myOpenings.pager} scroll={false} className="mt-4" />
        </section>

        <aside className="flex flex-col gap-8">
          <section>
            <h2 className="mb-3.5 text-[13px] font-semibold">Upcoming interviews</h2>
            <div className="rounded-xl border border-rule bg-surface">
              {interviews.length === 0 && (
                <p className="px-6 py-10 text-center text-[12.5px] text-ink-faint">
                  Nothing scheduled.
                </p>
              )}
              <div className="divide-y divide-rule">
                {interviews.map((iv) => {
                  const app = repo.application(iv.applicationId);
                  const cand = app ? repo.candidate(app.candidateId) : null;
                  const opening = app ? repo.opening(app.openingId) : null;
                  const confirmed = repo
                    .callFeedback(iv.applicationId)
                    .some((f) => f.kind === "pre_interview" && f.outcome === "reached");
                  return (
                    <Link
                      key={iv.id}
                      href={`/openings/${opening?.id}/candidate/${app?.id}?tab=call`}
                      className="block min-h-11 px-4 py-4 active:bg-paper/60 sm:px-6 sm:hover:bg-paper/60"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[13px] font-medium">{cand?.fullName}</span>
                        <span className="tabular shrink-0 text-[11.5px] text-ink-soft">
                          {inHours(iv.scheduledAt)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[11.5px] text-ink-faint">{opening?.title}</p>
                      <p className={`mt-1.5 text-[11.5px] ${confirmed ? "text-ink-soft" : "text-danger"}`}>
                        {confirmed ? "Attendance confirmed" : "Not yet contacted"}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>

          {routine.length > 0 && (
            <section>
              <h2 className="mb-3.5 text-[13px] font-semibold">When you have a moment</h2>
              <ul className="flex flex-col gap-3.5">
                {routine.slice(0, 6).map((a) => (
                  <li key={a.id} className="text-[12.5px] leading-relaxed">
                    <span className="text-ink-soft">{a.detail}</span>
                    <br />
                    <span className="text-ink-faint">{a.kind.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
