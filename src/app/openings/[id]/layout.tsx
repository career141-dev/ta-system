import { Suspense } from "react";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { ContextBar } from "@/components/ContextBar";
import { getCurrentUser } from "@/lib/session";
import { seatFor, visiblePosts } from "@/lib/visibility";
import { allows } from "@/lib/auth";

export default async function OpeningLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!repo.opening(id)) notFound();

  const user = await getCurrentUser();
  // Every page under an opening passes through here, so reading is refused
  // here once: somebody not on it gets a 404, not a page with buttons hidden.
  const assignment = repo.assignmentFor(id, user.id) ?? null;
  if (!allows(user, "opening.read", { openingId: id, assignment })) notFound();
  // What this person is on this opening decides what the rail even offers.
  const seat = seatFor(user, assignment?.role ?? null);
  const apps = repo.applications(id);
  // Two TAs on one opening each work their own posts — see lib/visibility.
  const posts = visiblePosts(repo.jobPosts(id), user).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    count: apps.filter((a) => a.jobPostId === p.id).length,
  }));

  return (
    <>
      <ContextBar openingId={id} />
      <div className="flex">
        {/* The rail reads ?post= to know which job post is showing. */}
        <Suspense fallback={<div className="w-[238px] shrink-0 border-r border-rule" />}>
          <ProjectSidebar openingId={id} posts={posts} canSeeSourcing={seat.canSeeSourcing} />
        </Suspense>
        <main className="min-w-0 flex-1 px-8 py-7">{children}</main>
      </div>
    </>
  );
}
