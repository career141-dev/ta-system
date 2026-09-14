import Link from "next/link";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { CandidateList, applyFilters, type ListFilters } from "@/components/CandidateList";
import { PostManager } from "@/components/PostManager";
import { ProjectHeader } from "../ProjectHeader";
import { StatRow } from "@/components/StatRow";
import { rowsOf, scopeApplications, visiblePosts } from "@/lib/visibility";

type Params = ListFilters & { post?: string };

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  live: "Live",
  paused: "Paused",
  closed: "Closed",
};

/**
 * One post or all of them — spec §4.2, and the 12 Sep review.
 *
 * The rail opens into the posts, and ?post= narrows this page to one of them.
 * The pool is still shared: a candidate who applied through the boosted title
 * is the same person as the one who applied through the original, so the
 * merged view stays the first row rather than a separate screen.
 */
export default async function LinkedInJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Params>;
}) {
  const { id } = await params;
  const { post: postId, ...filters } = await searchParams;
  const user = await getCurrentUser();
  const allPosts = repo.jobPosts(id);
  const posts = visiblePosts(allPosts, user);
  const all = rowsOf(scopeApplications(repo.applications(id), allPosts, user));

  const post = postId ? posts.find((p) => p.id === postId) : undefined;
  const scope = post ? all.filter((a) => a.jobPostId === post.id) : all;

  const everyone = scope.filter((a) => a.stage === "new_cv" && a.sourcingChannel !== "SCOOP");
  const apps = applyFilters(everyone, filters, user.id);

  const countsByPost: Record<string, number> = {};
  for (const a of all) if (a.jobPostId) countsByPost[a.jobPostId] = (countsByPost[a.jobPostId] ?? 0) + 1;

  const live = posts.filter((p) => p.status === "live");
  const cvsToday = post ? post.cvCountToday : live.reduce((n, p) => n + p.cvCountToday, 0);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[21px] font-semibold tracking-tight">
          {post ? post.title : "LinkedIn Job"}
        </h1>
        {post && (
          <>
            <span
              className={`rounded-md px-2 py-[3px] text-[11px] font-medium ${
                post.status === "live"
                  ? "bg-brand-soft text-brand"
                  : post.status === "paused"
                    ? "bg-warn-soft text-warn"
                    : "bg-tag text-ink-soft"
              }`}
            >
              {STATUS_LABEL[post.status]}
            </span>
            <Link
              href={`/openings/${id}/linkedin-job`}
              className="text-[12.5px] font-medium text-brand hover:underline"
            >
              All applicants
            </Link>
          </>
        )}
      </div>
      <ProjectHeader openingId={id} />

      <StatRow
        items={
          post
            ? [
                { n: countsByPost[post.id] ?? 0, label: "On this post" },
                { n: post.cvCountToday, label: "CVs today" },
                { n: everyone.length, label: "Waiting to be screened" },
              ]
            : [
                { n: live.length, label: live.length === 1 ? "Post live" : "Posts live" },
                { n: cvsToday, label: "CVs today" },
                { n: everyone.length, label: "Waiting to be screened" },
              ]
        }
      />

      {/*
        The posts live INSIDE the post view, not as a slab above every
        applicant. All applicants gets a thin row of chips to switch, and
        everything to do with managing an advert lives on that advert's own
        page, where it is being looked at anyway.
      */}
      {post ? (
        <details className="mb-5 border-b border-rule pb-1">
          <summary className="cursor-pointer py-2 text-[12.5px] text-ink-soft transition-colors hover:text-ink">
            Advert settings
          </summary>
          <div className="pb-3">
            <PostManager
              openingId={id}
              posts={posts.filter((p) => p.id === post.id)}
              users={repo.users()}
              countsByPost={countsByPost}
              bare
            />
          </div>
        </details>
      ) : (
        posts.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-faint">Posts</span>
            {posts.map((p) => (
              <Link
                key={p.id}
                href={`/openings/${id}/linkedin-job?post=${p.id}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1 text-[12.5px] text-ink-soft transition-colors hover:border-rule-strong hover:text-ink"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    p.status === "live"
                      ? "bg-brand"
                      : p.status === "paused"
                        ? "bg-warn"
                        : "bg-rule-strong"
                  }`}
                />
                {p.title}
                <span className="tabular text-[11.5px] text-ink-faint">
                  {countsByPost[p.id] ?? 0}
                </span>
              </Link>
            ))}
            <Link
              href={`/openings/${id}/linkedin-job?post=${posts[0].id}`}
              className="ml-1 text-[12px] text-ink-faint transition-colors hover:text-ink"
            >
              Settings
            </Link>
          </div>
        )
      )}

      <CandidateList
        scored
        openingId={id}
        apps={apps}
        currentUser={user}
        title="Applicants"
        filters={filters}
        claimable
        basePath={`/openings/${id}/linkedin-job`}
        keepQuery={post ? { post: post.id } : {}}
      />
    </>
  );
}
