import { notFound } from "next/navigation";
import { openingFacts } from "./ProjectHeader";
import Link from "next/link";
import { HealthBar } from "@/components/HealthBar";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { PIPELINE_STAGES, STAGE_LABEL, PRIORITY_TARGET, URGENT_ALERTS } from "@/data/types";
import { relDays } from "@/lib/format";
import { JdApproval } from "@/components/JdApproval";
import { JobDetailsSummary } from "@/components/JobDetailsSummary";
import { OpeningAdmin } from "./OpeningAdmin";
import { computeAlerts } from "@/lib/sla";
import { allows } from "@/lib/auth";
import { setOpeningAutoFollowUp, setOpeningQuestions } from "@/app/actions";
import { primeStore } from "@/data/prime";

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
      <div className="mb-8 flex items-start justify-between gap-8">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
            {openingFacts(o)}
          </p>
        </div>
        <div className="flex shrink-0 gap-9 text-right">
          <div>
            <div className="tabular text-[20px] font-semibold leading-none">{inPipeline}</div>
            <div className="mt-1.5 text-[12px] text-ink-soft">In pipeline</div>
          </div>
          <div>
            <div className="tabular text-[20px] font-semibold leading-none">{cvsToday}</div>
            <div className="mt-1.5 text-[12px] text-ink-soft">CVs today</div>
          </div>
          <div>
            <div className="tabular text-[20px] font-semibold leading-none">
              {days}
              <span className="text-[13px] font-normal text-ink-faint">/{target.days}</span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-soft">Days in</div>
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

      {/* The facts only; the form is edited on the Job description page, beside
          the JD it is read from (testing, 21 Sep). */}
      {o.requirements && <JobDetailsSummary openingId={id} requirements={o.requirements} />}

      {suggested.length > 0 && (
        <section className="mb-9">
          <h2 className="mb-3 text-[13px] font-medium text-ink-soft">Suggested actions</h2>
          <div
            className={`grid gap-4 sm:grid-cols-2 ${
              suggested.length % 3 === 0 ? "lg:grid-cols-3" : suggested.length === 4 ? "lg:grid-cols-2 xl:grid-cols-4" : "lg:grid-cols-3"
            }`}
          >
            {suggested.map((s) => (
              <div
                key={s.title}
                className="flex flex-col justify-between rounded-xl border border-rule bg-surface p-5"
              >
                <div>
                  <p className="text-[13.5px] font-medium leading-snug">{s.title}</p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{s.sub}</p>
                </div>
                <Link
                  href={s.href}
                  className="mt-5 self-end text-[12.5px] font-medium text-brand hover:underline"
                >
                  {s.action}
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-12 lg:grid-cols-[1fr_270px]">
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-ink-soft">Pipeline</h2>
          <div className="rounded-xl border border-rule bg-surface px-5">
            {PIPELINE_STAGES.map((s) => (
              <Link
                key={s}
                href={`/openings/${id}/pipeline/${s}`}
                className="flex items-baseline gap-4 border-b border-rule py-3.5 last:border-b-0"
              >
                <span className="flex-1 text-[13.5px] hover:underline">{STAGE_LABEL[s]}</span>
                <span className="tabular text-[13.5px] text-ink-soft">{counts[s] ?? 0}</span>
              </Link>
            ))}
          </div>
        </section>

        <aside className="flex flex-col gap-9">
          <div>
            <h2 className="mb-3 text-[13px] font-medium text-ink-soft">Recent activity</h2>
            <ul className="flex flex-col gap-3.5">
              {activity.length === 0 && (
                <li className="text-[12.5px] text-ink-faint">Nothing yet.</li>
              )}
              {activity.map((a) => {
                const c = repo.candidate(a.candidateId);
                const who = users.find((u) => u.id === a.ownerTaId);
                return (
                  <li key={a.id} className="text-[12.5px] leading-relaxed">
                    <span className="text-ink">{c?.fullName}</span>
                    <span className="text-ink-soft"> moved to {STAGE_LABEL[a.stage].toLowerCase()}</span>
                    <br />
                    <span className="text-ink-faint">
                      {who?.name} · {relDays(a.lastStageChangedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <h2 className="mb-3 text-[13px] font-medium text-ink-soft">About this opening</h2>
            <dl className="flex flex-col gap-2 text-[12.5px] leading-relaxed">
              <div>
                <dt className="inline text-ink-faint">Team </dt>
                <dd className="inline">
                  {o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name).join(", ")}
                </dd>
              </div>
              <div>
                <dt className="inline text-ink-faint">Lead </dt>
                <dd className="inline">{users.find((u) => u.id === o.taLeadId)?.name}</dd>
              </div>
              <div>
                <dt className="inline text-ink-faint">Sets </dt>
                <dd className="inline">
                  {sets.filter((s) => s.status === "closed").length} finished
                  {openSet && `, your set ${openSet.setNumber} has ${openSet.count}`}
                </dd>
              </div>
              <div>
                <dt className="inline text-ink-faint">Reference </dt>
                <dd className="inline tabular">{o.positionCode}</dd>
              </div>
              {alerts.length > 0 && (
                <div className="mt-1">
                  <dt className="inline text-ink-faint">Needs attention </dt>
                  <dd className="inline">
                    {alerts.length}
                    {alerts.some((a) => URGENT_ALERTS.includes(a.kind)) && " · one is urgent"}
                  </dd>
                </div>
              )}
            </dl>

            {/* Automatic follow-up: reminders after the TA's first Send. */}
            <div className="mt-4 rounded-lg border border-rule bg-paper px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium text-ink">
                  Automatic follow-up
                  <span className={`ml-1.5 font-normal ${o.autoFollowUp ? "text-brand" : "text-ink-faint"}`}>
                    · {o.autoFollowUp ? "on" : "off"}
                  </span>
                </span>
                {allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null }) && (
                  <form action={setOpeningAutoFollowUp}>
                    <input type="hidden" name="openingId" value={id} />
                    <input type="hidden" name="enabled" value={o.autoFollowUp ? "off" : "on"} />
                    <button className="rounded-full border border-rule px-3 py-1 text-[11.5px] font-medium hover:bg-tag">
                      {o.autoFollowUp ? "Turn off" : "Turn on"}
                    </button>
                  </form>
                )}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                {o.autoFollowUp
                  ? "After you send a candidate the first follow-up, WhatsApp and email reminders go out every 24 hours until the details are in or the reminders run out."
                  : "Follow-ups go out only when you press Send on a candidate."}
              </p>
            </div>

            {/* The TA's own follow-up questions for this job. */}
            <details className="mt-4 rounded-xl border border-rule bg-surface px-4 py-3">
              <summary className="cursor-pointer text-[12.5px] font-medium">
                Follow-up questions
                <span className="font-normal text-ink-faint">
                  {" "}· {repo.followUpStandard().filter((q) => q.enabled).length} standard
                  {o.followUpQuestions.length > 0 && ` + ${o.followUpQuestions.length} for this job`}
                </span>
              </summary>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
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
                    className="w-full rounded border border-rule bg-paper px-2.5 py-2 text-[12.5px]"
                  />
                  <div>
                    <button className="rounded-full border border-rule-strong px-3.5 py-1.5 text-[12px] font-medium">Save</button>
                  </div>
                </form>
              ) : (
                <ul className="mt-2 list-disc pl-5 text-[12px] text-ink-soft">
                  {o.followUpQuestions.map((q) => <li key={q.id}>{q.label}</li>)}
                </ul>
              )}
            </details>

            <div className="mt-4">
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
                /* The TA running the role can correct its details. Deleting it,
                   and everything filed under it, stays with the lead. */
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
