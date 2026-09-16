import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { reviewDecisions, reviewJobs, reviewList } from "@/lib/review";
import { primeStore } from "@/data/prime";
import { matchesQuery } from "@/lib/paging";

export default async function ReviewIndex({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const jobs = reviewJobs();
  if (jobs.length === 0) notFound();
  const openings = repo.openings();

  return (
    <main className="mx-auto w-full max-w-[860px] px-6 py-10">
      <h1 className="text-[22px] font-semibold tracking-tight">Recruiter review</h1>
      <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">
        For each person, decide as you would when shortlisting for that job: <b>Shortlist</b>, <b>Maybe</b> or <b>Reject</b>.
        The platform&rsquo;s scores and picks are hidden, so your decisions are an independent check. Nobody is contacted and
        nothing moves in any pipeline.
      </p>
      <div className="mt-7 overflow-hidden rounded-2xl border border-rule bg-surface">
        {jobs.filter((n) => {
          const o = openings[n - 1];
          return matchesQuery(q, o?.title, repo.client(o?.clientId ?? "")?.name, o?.locations.join(" "));
        }).map((n, i) => {
          const o = openings[n - 1];
          const total = reviewList(n).length;
          const done = reviewDecisions(user.id, n).size;
          return (
            <Link key={n} href={`/review/${n}`} className={`flex items-center justify-between gap-4 px-6 py-4 hover:bg-paper ${i ? "border-t border-rule" : ""}`}>
              <span>
                <span className="block text-[14px] font-medium">{o?.title}</span>
                <span className="block text-[12px] text-ink-faint">{repo.client(o?.clientId ?? "")?.name} · {o?.locations.join(", ")}</span>
              </span>
              <span className={`tabular rounded-full px-3 py-1 text-[12px] font-medium ${done === total ? "bg-brand-soft text-brand" : "bg-tag text-ink-soft"}`}>
                {done} of {total} reviewed
              </span>
            </Link>
          );
        })}
      </div>
      <p className="mt-4 text-[12px] text-ink-faint">Signed in as {user.name}. Each person reviews under their own account.</p>
    </main>
  );
}
