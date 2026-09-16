import { notFound } from "next/navigation";
import Link from "next/link";
import { HealthBar } from "@/components/HealthBar";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { PIPELINE_STAGES, STAGE_LABEL, PRIORITY_TARGET, URGENT_ALERTS, type Stage } from "@/data/types";
import { relDays } from "@/lib/format";
import { JdApproval } from "@/components/JdApproval";
import { JobDetailsPanel } from "@/components/JobDetailsPanel";
import { OpeningAdmin } from "./OpeningAdmin";
import { computeAlerts } from "@/lib/sla";
import { allows } from "@/lib/auth";
import { setOpeningQuestions } from "@/app/actions";
import { primeStore } from "@/data/prime";

const STAGE_DESCRIPTIONS: Partial<Record<Stage, string>> = {
  follow_up: "AI calls, WhatsApp & detail checks",
  director_review: "Candidate packs ready for internal sign-off",
  director_shortlist: "Approved internally, queued for client",
  client_shortlist: "Sent to client, awaiting feedback",
  interview: "Interview rounds in progress",
  offer: "Package agreement & negotiations",
  placed: "Placement confirmed & finalized",
};

/**
 * Modelled on Recruiter's project overview: a short state line, a few suggested
 * actions that each say plainly what to do, then activity. No tile wall.
 */
export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string }>;
}) {
  const { id } = await params;
  const { msg } = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();
  const o = repo.opening(id);
  if (!o) notFound();
  const counts = stageCounts(id);
  // This person's own sets — each TA numbers their own.
  const sets = setsForOpening(id);
  const openSet = sets.find((s) => s.status === "open" && s.taId === user.id);
  const apps = repo.applications(id);
  const posts = repo.jobPosts(id).filter((p) => p.status === "live");
  const cvsToday = posts.reduce((n, p) => n + p.cvCountToday, 0);
  const days = Math.floor((Date.now() - (o.assignedAt ?? Date.now())) / 86_400_000);
  const health = repo.health(id);
  const target = PRIORITY_TARGET[o.priorityTier];
  const users = repo.users();
  const inPipeline = PIPELINE_STAGES.reduce((n, s) => n + (counts[s] ?? 0), 0);

  // What the lead's brief actually yielded, shown before the TA generates.
  // Found by opening: the Convex backend does not set `briefId`. The first
  // brief is the lead's from creation; TAs' notes come after it.
  const brief = repo.briefsForOpening(id)[0] ?? (o.briefId ? repo.brief(o.briefId) : null);
  const be = brief?.extracted;
  const briefSummary = [
    be?.salaryMin
      ? `${be.currency} ${be.salaryMin.toLocaleString()}${be.salaryMax ? `–${be.salaryMax.toLocaleString()}` : ""}`
      : null,
    be?.locations.length ? be.locations.join(", ") : null,
    be?.nationalities.length ? `${be.nationalities.join(", ")} only` : null,
    be?.mustHaves.length ? `${be.mustHaves.length} requirements` : null,
    be?.priorityTier ? be.priorityTier : null,
  ].filter(Boolean) as string[];
  const inbox = apps.filter((a) => a.stage === "new_cv" || a.stage === "matched").length;
  // Computed, the same list the Alerts page shows — not the stored rows.
  const alerts = computeAlerts().filter(
    (a) => a.subjectId === id || apps.some((x) => x.id === a.subjectId),
  );

  const suggested = [
    inbox > 0 && {
      title: `Review ${inbox} unscreened ${inbox === 1 ? "CV" : "CVs"}`,
      sub: "Applicants and database matches nobody has claimed",
      href: `/openings/${id}/database`,
      action: "Review",
    },
    openSet && {
      title: `Set ${openSet.setNumber} has ${openSet.count} so far`,
      sub:
        openSet.count >= 5
          ? "It goes to the Director tonight, and tomorrow starts the next set"
          : `It goes to the Director tonight as it is, and carries on as set ${openSet.setNumber} tomorrow`,
      href: `/openings/${id}/eod`,
      action: "End of day",
    },
    (counts.director_review ?? 0) > 0 && {
      title: `${counts.director_review} ready for the Director`,
      sub: "Send the end-of-day email with their prepared CVs attached",
      href: `/openings/${id}/eod`,
      action: "Review email",
    },
    (counts.follow_up ?? 0) > 0 && {
      title: `${counts.follow_up} in follow-up`,
      sub: "The AI call, WhatsApp and email are working through their details today",
      href: `/openings/${id}/pipeline/follow_up`,
      action: "Continue",
    },
  ].filter(Boolean) as { title: string; sub: string; href: string; action: string }[];

  const activity = apps
    .filter((a) => a.ownerTaId)
    .sort((x, y) => y.lastStageChangedAt - x.lastStageChangedAt)
    .slice(0, 5);

  return (
    <>
      <div className="mb-7 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            {o.locations.join(", ")} · {o.packageNotes}
            {o.targetNationalities.length > 0 && ` · ${o.targetNationalities.join(", ")} only`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="min-w-[105px] rounded-xl border border-rule bg-surface px-4 py-2.5 text-center shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
            <div className="tabular text-[19px] font-semibold leading-none text-ink">{inPipeline}</div>
            <div className="mt-1 text-[11px] font-medium text-ink-soft">In pipeline</div>
          </div>
          <div className="min-w-[105px] rounded-xl border border-rule bg-surface px-4 py-2.5 text-center shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
            <div className="tabular text-[19px] font-semibold leading-none text-ink">{cvsToday}</div>
            <div className="mt-1 text-[11px] font-medium text-ink-soft">CVs today</div>
          </div>
          <div className="min-w-[105px] rounded-xl border border-rule bg-surface px-4 py-2.5 text-center shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
            <div className="tabular text-[19px] font-semibold leading-none text-ink">
              {days}
              <span className="text-[12px] font-normal text-ink-faint">/{target.days}</span>
            </div>
            <div className="mt-1 text-[11px] font-medium text-ink-soft">Days in</div>
          </div>
        </div>
      </div>

      {/* Is this role on track, and if not, what is wrong with it. */}
      {health && <HealthBar health={health} />}

      {o.jdStatus === "pending_ta_approval" && (
        <JdApproval
          openingId={id}
          jd={o.jdMarkdown}
          canApprove={o.assignedTaIds.includes(user.id) || user.role === "admin"}
          approverLabel={o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name).join(" or ")}
          hasBrief={Boolean(brief && (brief.notesMarkdown.trim() || brief.recordingKey))}
          briefSummary={briefSummary}
        />
      )}

      {/* Shown as soon as there is something in it: read from the lead's brief
          and the TA's notes when the JD is drafted, before approval. */}
      {o.requirements && (o.jdStatus === "approved" || o.requirements.editedAt || o.requirements.status !== null) && (
        <JobDetailsPanel
          openingId={id}
          title={o.title}
          requirements={o.requirements}
          jdApproved={o.jdStatus === "approved"}
          canEdit={allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null })}
          editedByName={users.find((u) => u.id === o.requirements?.editedBy)?.name ?? null}
        />
      )}

      {suggested.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold text-ink-soft">Suggested actions</h2>
          <div
            className={`grid gap-3 sm:grid-cols-2 ${
              suggested.length % 3 === 0 ? "lg:grid-cols-3" : suggested.length === 4 ? "lg:grid-cols-2 xl:grid-cols-4" : "lg:grid-cols-3"
            }`}
          >
            {suggested.map((s) => (
              <div
                key={s.title}
                className="flex flex-col justify-between rounded-xl border border-rule bg-surface p-4 shadow-[0_1px_2px_rgba(23,28,24,0.03)]"
              >
                <div>
                  <p className="text-[13.5px] font-medium leading-snug text-ink">{s.title}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{s.sub}</p>
                </div>
                <Link
                  href={s.href}
                  className="mt-4 self-end rounded-full border border-brand-line px-3.5 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand hover:text-white"
                >
                  {s.action}
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_290px]">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[14px] font-semibold text-ink">Pipeline Flow</h2>
              <p className="text-[12px] text-ink-soft">Progression stages from follow-up to placement</p>
            </div>
            <span className="rounded-full bg-tag px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
              {inPipeline} active
            </span>
          </div>

          <div className="rounded-2xl border border-rule bg-surface p-5 shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
            <div className="relative flex flex-col">
              {PIPELINE_STAGES.map((s, idx) => {
                const count = counts[s] ?? 0;
                const hasCount = count > 0;
                const isLast = idx === PIPELINE_STAGES.length - 1;
                return (
                  <div key={s} className="relative flex items-start gap-4">
                    {/* Connecting line */}
                    {!isLast && (
                      <span
                        className="absolute left-[11px] top-6 bottom-0 w-[2px] bg-rule"
                        aria-hidden="true"
                      />
                    )}

                    {/* Step indicator dot */}
                    <div className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface pt-0.5">
                      <span
                        className={`h-3 w-3 rounded-full transition-all ${
                          hasCount
                            ? "bg-brand ring-4 ring-brand/15"
                            : "bg-rule-strong"
                        }`}
                      />
                    </div>

                    {/* Content link */}
                    <Link
                      href={`/openings/${id}/pipeline/${s}`}
                      className={`group mb-2 flex flex-1 items-center justify-between rounded-xl px-3.5 py-2.5 transition-all ${
                        hasCount
                          ? "bg-brand-soft/25 hover:bg-brand-soft/45"
                          : "hover:bg-paper"
                      }`}
                    >
                      <div className="min-w-0">
                        <span className="text-[13.5px] font-semibold text-ink group-hover:text-brand transition-colors">
                          {STAGE_LABEL[s]}
                        </span>
                        <p className="mt-0.5 text-[11.5px] text-ink-faint">
                          {STAGE_DESCRIPTIONS[s] ?? ""}
                        </p>
                      </div>
                      <div className="ml-4 shrink-0">
                        <span
                          className={`tabular rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${
                            hasCount
                              ? "bg-brand text-white shadow-xs"
                              : "bg-tag text-ink-faint group-hover:text-ink-soft"
                          }`}
                        >
                          {count}
                        </span>
                      </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="flex flex-col gap-6">
          <div className="rounded-xl border border-rule bg-surface p-4 shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
            <h2 className="mb-3 text-[13px] font-semibold text-ink-soft">Recent activity</h2>
            <ul className="flex flex-col gap-3">
              {activity.length === 0 && (
                <li className="text-[12px] text-ink-faint">Nothing yet.</li>
              )}
              {activity.map((a) => {
                const c = repo.candidate(a.candidateId);
                const who = users.find((u) => u.id === a.ownerTaId);
                return (
                  <li key={a.id} className="text-[12px] leading-relaxed border-b border-rule pb-2.5 last:border-b-0 last:pb-0">
                    <span className="font-medium text-ink">{c?.fullName}</span>
                    <span className="text-ink-soft"> moved to {STAGE_LABEL[a.stage].toLowerCase()}</span>
                    <br />
                    <span className="text-ink-faint text-[11px]">
                      {who?.name} · {relDays(a.lastStageChangedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-xl border border-rule bg-surface p-4 shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
            <h2 className="mb-3 text-[13px] font-semibold text-ink-soft">About this opening</h2>
            <dl className="flex flex-col gap-2.5 text-[12px] leading-relaxed">
              <div className="flex items-center justify-between border-b border-rule pb-2">
                <dt className="text-ink-faint">Team</dt>
                <dd className="font-medium text-ink text-right">
                  {o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name).join(", ")}
                </dd>
              </div>
              <div className="flex items-center justify-between border-b border-rule pb-2">
                <dt className="text-ink-faint">Lead</dt>
                <dd className="font-medium text-ink">{users.find((u) => u.id === o.taLeadId)?.name}</dd>
              </div>
              <div className="flex items-center justify-between border-b border-rule pb-2">
                <dt className="text-ink-faint">Sets</dt>
                <dd className="font-medium text-ink">
                  {sets.filter((s) => s.status === "closed").length} finished
                  {openSet && `, set ${openSet.setNumber} (${openSet.count})`}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-faint">Reference</dt>
                <dd className="tabular font-medium text-ink">{o.positionCode}</dd>
              </div>
              {alerts.length > 0 && (
                <div className="mt-1 rounded-lg bg-warn/10 p-2 text-warn text-[11.5px] font-medium">
                  {alerts.length} item{alerts.length > 1 ? "s" : ""} need attention
                  {alerts.some((a) => URGENT_ALERTS.includes(a.kind)) && " · urgent"}
                </div>
              )}
            </dl>

            {/* The TA's own follow-up questions for this job. */}
            <details className="mt-4 rounded-lg border border-rule bg-paper px-3.5 py-2.5">
              <summary className="cursor-pointer text-[12px] font-medium text-ink">
                Follow-up questions
                <span className="font-normal text-ink-faint">
                  {" "}· {repo.followUpStandard().filter((q) => q.enabled).length} std
                  {o.followUpQuestions.length > 0 && ` + ${o.followUpQuestions.length} custom`}
                </span>
              </summary>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                Always asked: {repo.followUpStandard().filter((q) => q.enabled).map((q) => q.label.toLowerCase()).join(", ")}.
                Add anything else this job needs, one per line.
              </p>
              {allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null }) ? (
                <form action={setOpeningQuestions} className="mt-2 grid gap-2">
                  <input type="hidden" name="openingId" value={id} />
                  <textarea
                    name="questions"
                    rows={3}
                    defaultValue={o.followUpQuestions.map((q) => q.label).join("\n")}
                    placeholder={"Valid driving licence?\nWilling to travel to Bangladesh?"}
                    className="w-full rounded border border-rule bg-surface px-2.5 py-2 text-[12px] outline-none focus:border-brand"
                  />
                  <div>
                    <button className="rounded-full border border-rule px-3 py-1 text-[11.5px] font-medium hover:bg-tag">Save</button>
                  </div>
                </form>
              ) : (
                <ul className="mt-2 list-disc pl-5 text-[11.5px] text-ink-soft">
                  {o.followUpQuestions.map((q) => <li key={q.id}>{q.label}</li>)}
                </ul>
              )}
            </details>

            <div className="mt-3.5 pt-2">
              <OpeningAdmin
                openingId={id}
                title={o.title}
                salaryMin={o.salaryMin}
                salaryMax={o.salaryMax}
                salaryCurrency={o.salaryCurrency}
                packageNotes={o.packageNotes}
                locations={o.locations}
                targetNationalities={o.targetNationalities}
                headcount={o.headcount}
                priorityTier={o.priorityTier}
                team={repo.assignments(id).map((a) => ({ userId: a.userId, role: a.role }))}
                people={users
                  .filter((u) => u.isActive)
                  .map((u) => ({ id: u.id, name: u.name, role: u.role }))}
                canEdit={o.assignedTaIds.includes(user.id) || user.role !== "ta"}
                canDelete={user.role !== "ta"}
                counts={{
                  applications: repo.applications(id).length,
                  posts: repo.jobPosts(id).length,
                  links: repo.linkVault(id).length,
                }}
              />
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
