import { Suspense } from "react";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { ContextBar } from "@/components/ContextBar";
import { getCurrentUser } from "@/lib/session";
import { seatFor, visiblePosts, visibleToSeat } from "@/lib/visibility";
import { allows, isDeskWide, isTa, seesEveryTaRow } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { NO_SHEET, levelLabel } from "@/lib/linkViews";
import { isConvex } from "@/data/mode";
import { convexQuery } from "@/lib/convexServer";
import type { DailyEmail } from "@/lib/dailyEmail";
import { workdayDate } from "@/lib/workday";
import { OpeningAccessNeeded, type AvailableOpening } from "@/components/OpeningAccessRequests";
import { ProblemState } from "@/components/ProblemState";

export default async function OpeningLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const opening = repo.opening(id);
  if (!opening) notFound();

  const user = await getCurrentUser();
  // Every page under an opening passes through here. A requestable opening
  // explains how a TA can get access; protected openings stay undisclosed.
  const assignment = repo.assignmentFor(id, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(id).some((r) => r.doneBy.includes(user.id));
  if (!allows(user, "opening.read", { openingId: id, assignment, onStrategy })) {
    const available = isTa(user) && isConvex()
      ? await convexQuery<AvailableOpening[]>("ta/openingAccess:listAvailable", { actorId: user.id })
          .then((rows) => rows.find((row) => row.id === id) ?? null)
          .catch(() => null)
      : null;
    if (available) return <OpeningAccessNeeded opening={available} />;
    return (
      <ProblemState
        title="Opening unavailable"
        message="You may not have access to this opening, or it is no longer available. Choose an opening from your assigned list."
        primaryHref="/openings"
        primaryLabel="Go to Openings"
      />
    );
  }
  // What this person is on this opening decides what the rail even offers.
  const seat = seatFor(user, assignment?.role ?? null, onStrategy);
  // Strategy-only access includes sourcing, but not the recruiter's Midday/EOD
  // workflow. Querying those records for a strategy assignee makes the backend
  // correctly refuse the request and leaves the opening on its loading screen.
  const canUseDailyEmail = seat.canAct;
  const dailyEmails = canUseDailyEmail && isConvex()
    ? await convexQuery<DailyEmail[]>("ta/dailyEmails:list", { actorId: user.id, jobId: id }) : [];
  const todayEmails = dailyEmails.filter(e => e.userId === user.id && e.date === workdayDate(Date.now()));
  const apps = visibleToSeat(repo.applications(id), seat);
  // Two TAs on one opening each work their own posts — see lib/visibility.
  const posts = visiblePosts(repo.jobPosts(id), user).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    count: apps.filter((a) => a.jobPostId === p.id).length,
  }));
  // The L's this person started under Excel Tables, with how many rows each
  // holds — the same sheets and counts as the table's tabs (22 Oct). A lead's
  // are their own, opened under their name; every TA's L's together were
  // several people's L1 under one number.
  const isLeadViewer = isDeskWide(user) || seesEveryTaRow(user);
  const myLevels = seat.canSeeSourcing ? repo.linkLevels(id, user.id) : [];
  const mine = seat.canSeeSourcing ? repo.linkVault(id).filter((r) => r.addedBy === user.id && !r.workLocationId) : [];
  const own = isLeadViewer ? `by=${encodeURIComponent(user.id)}&` : "";
  const levels: { n: number; label: string; name: string; count: number; canManage?: boolean; query: string }[] = myLevels.map((l) => ({
    n: l.n,
    label: levelLabel(l),
    name: l.name ?? "",
    count: mine.filter((r) => r.level === l.n).length,
    canManage: true,
    query: `${own}level=${l.n}`,
  }));
  const noSheet = mine.filter((r) => !(r.level && r.level > 0)).length;
  if (noSheet > 0) levels.push({ n: NO_SHEET, label: "Not in a sheet", name: "", count: noSheet, canManage: false, query: `${own}level=none` });

  return (
    <>
      <ContextBar openingId={id} />
      {/* Side by side from 1024px; on a phone the rail folds into a menu above the page. */}
      <div className="flex flex-col lg:flex-row">
        {/* The rail reads ?post= to know which job post is showing. */}
        <Suspense fallback={<div className="hidden w-[238px] shrink-0 border-r border-rule lg:block" />}>
          <ProjectSidebar locationSheets={!!opening.workLocations?.length} openingId={id} posts={posts} levels={levels} nextLevel={repo.nextLinkLevel(id, user.id)} canSeeSourcing={seat.canSeeSourcing} canUseDailyEmail={canUseDailyEmail}
            middayEmails={todayEmails.filter(e => e.submissionType === "midday").map(e => ({ id: e._id, number: e.number, status: e.status }))}
            dailyEmailClosed={opening.workLocations?.length ? opening.workLocations.filter(l => !l.archived).every(l => todayEmails.some(e => e.workLocationId === l.id && e.submissionType === "eod" && e.status === "accepted" && !e.parentId && !e.recoveryReopenedAt)) : todayEmails.some(e => e.submissionType === "eod" && e.status === "accepted" && !e.parentId && !e.recoveryReopenedAt)} />
        </Suspense>
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </>
  );
}
