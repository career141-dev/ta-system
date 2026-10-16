import { Suspense } from "react";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { ContextBar } from "@/components/ContextBar";
import { getCurrentUser } from "@/lib/session";
import { seatFor, visiblePosts, visibleToSeat } from "@/lib/visibility";
import { allows } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { levelLabel } from "@/lib/linkViews";

export default async function OpeningLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await primeStore({ openingId: id });
  if (!repo.opening(id)) notFound();

  const user = await getCurrentUser();
  // Every page under an opening passes through here, so reading is refused
  // here once: somebody not on it gets a 404, not a page with buttons hidden.
  const assignment = repo.assignmentFor(id, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(id).some((r) => r.doneBy.includes(user.id));
  if (!allows(user, "opening.read", { openingId: id, assignment, onStrategy })) notFound();
  // What this person is on this opening decides what the rail even offers.
  const seat = seatFor(user, assignment?.role ?? null);
  const apps = visibleToSeat(repo.applications(id), seat);
  // Two TAs on one opening each work their own posts — see lib/visibility.
  const posts = visiblePosts(repo.jobPosts(id), user).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    count: apps.filter((a) => a.jobPostId === p.id).length,
  }));
  // The L's this person started under Excel Tables, with how many rows each holds.
  const mine = seat.canSeeSourcing ? repo.linkVault(id).filter((r) => r.addedBy === user.id) : [];
  const levels = seat.canSeeSourcing
    ? repo.linkLevels(id, user.id).map((l) => ({
        n: l.n,
        label: levelLabel(l),
        name: l.name ?? "",
        count: mine.filter((r) => r.level === l.n).length,
      }))
    : [];

  return (
    <>
      <ContextBar openingId={id} />
      {/* Side by side from 1024px; on a phone the rail folds into a menu above the page. */}
      <div className="flex flex-col lg:flex-row">
        {/* The rail reads ?post= to know which job post is showing. */}
        <Suspense fallback={<div className="hidden w-[238px] shrink-0 border-r border-rule lg:block" />}>
          <ProjectSidebar openingId={id} posts={posts} levels={levels} nextLevel={repo.allLinkLevels(id, user.id).length + 1} canSeeSourcing={seat.canSeeSourcing} />
        </Suspense>
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </>
  );
}
