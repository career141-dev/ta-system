import { Suspense } from "react";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { ContextBar } from "@/components/ContextBar";
import { getCurrentUser } from "@/lib/session";
import { seatFor, visiblePosts, visibleToSeat } from "@/lib/visibility";
import { allows, isDeskWide, isTa, seesEveryTaRow } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { levelLabel } from "@/lib/linkViews";
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
  // The L's this person started under Excel Tables, with how many rows each holds.
  const isLeadViewer = isDeskWide(user) || seesEveryTaRow(user);
  const myLevels = seat.canSeeSourcing ? repo.linkLevels(id, user.id) : [];
  const vaultRows = seat.canSeeSourcing ? repo.linkVault(id) : [];
  const mine = vaultRows.filter((r) => r.addedBy === user.id);

  let levels: { n: number; label: string; name: string; count: number; canManage?: boolean }[] = [];
  if (seat.canSeeSourcing) {
    if (myLevels.length > 0 || !isLeadViewer) {
      levels = myLevels.map((l) => ({
        n: l.n,
        label: levelLabel(l),
        name: l.name ?? "",
        count: mine.filter((r) => r.level === l.n).length,
        canManage: true,
      }));
    } else {
      // For leads/admin who haven't started their own L's, show the opening's L's so they can navigate them
      const allLevelsMap = new Map<number, { n: number; at: number; name?: string }>();
      const adders = [...new Set(vaultRows.map((r) => r.addedBy))];
      for (const uid of adders) {
        for (const l of repo.linkLevels(id, uid)) {
          if (!allLevelsMap.has(l.n)) allLevelsMap.set(l.n, { ...l });
        }
      }
      for (const r of vaultRows) {
        if (typeof r.level === "number" && r.level > 0 && !allLevelsMap.has(r.level)) {
          allLevelsMap.set(r.level, { n: r.level, at: 0 });
        }
      }
      levels = Array.from(allLevelsMap.values())
        .sort((a, b) => a.n - b.n)
        .map((l) => ({
          n: l.n,
          label: l.at ? levelLabel(l) : `L${l.n}`,
          name: l.name ?? "",
          count: vaultRows.filter((r) => r.level === l.n).length,
          canManage: false,
        }));
    }
  }

  return (
    <>
      <ContextBar openingId={id} />
      {/* Side by side from 1024px; on a phone the rail folds into a menu above the page. */}
      <div className="flex flex-col lg:flex-row">
        {/* The rail reads ?post= to know which job post is showing. */}
        <Suspense fallback={<div className="hidden w-[238px] shrink-0 border-r border-rule lg:block" />}>
          <ProjectSidebar openingId={id} posts={posts} levels={levels} nextLevel={repo.allLinkLevels(id, user.id).length + 1} canSeeSourcing={seat.canSeeSourcing} canUseDailyEmail={canUseDailyEmail}
            middayEmails={todayEmails.filter(e => e.submissionType === "midday").map(e => ({ id: e._id, number: e.number, status: e.status }))}
            dailyEmailClosed={todayEmails.some(e => e.submissionType === "eod" && e.status === "accepted" && !e.parentId)} />
        </Suspense>
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </>
  );
}
