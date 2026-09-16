import Link from "next/link";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { listScans } from "@/lib/scan";
import { relDays } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 20;

/**
 * The CV scanner.
 *
 * The one screen this integration adds, because the feature it exposes had no
 * home in the platform: read a pile of CVs against a list of criteria written
 * in plain words, and get a score per criterion with the sentence from the CV
 * that supports it.
 *
 * Deliberately a list and a link rather than a new workflow. Scanning is an
 * occasional job — a folder arrives, somebody wants to know which of the
 * eighty are worth opening — and it does not belong in the pipeline the desk
 * works every day.
 */
export default async function ScanPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const sp = await searchParams;
  await primeStore({ allApplications: true });
  const user = await pageUser("database.read");
  const allScans = isConvex() ? await listScans() : [];
  const matching = allScans.filter((s) => matchesQuery(sp.q, s.title, ...s.criteria));
  const page = pageFrom(sp, matching.length, PAGE_SIZE);
  const scans = slicePage(matching, page, PAGE_SIZE);

  return (
    <main className="mx-auto max-w-[880px] px-8 py-9">
      <Link href="/database" className="text-[12.5px] text-ink-soft hover:text-ink">
        ← Database
      </Link>

      <header className="mt-3">
        <h1 className="text-[24px] font-semibold tracking-tight">Scan a pile of CVs</h1>
        <p className="mt-1.5 max-w-[60ch] text-[13px] leading-relaxed text-ink-soft">
          Write what you are looking for in plain words — one line each. Every CV is read
          against all of them and comes back with a score per line and the sentence that
          supports it, so a weak match can be told from a confident one.
        </p>
      </header>

      <p className="mt-6 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
        <b>Not ready yet.</b> You can't start a new scan from here: uploading CVs isn't built
        into this screen. The list below only shows scans already in the system.
      </p>

      {!isConvex() && (
        <p className="mt-6 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
          The scanner reads from the live database, and this build is running on the
          local sample. Set <code>C141_STORE=convex</code> to use it.
        </p>
      )}

      <section className="mt-7">
        <h2 className="mb-3 text-[13px] font-semibold">Recent scans</h2>
        <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
          {scans.length === 0 ? (
            <p className="px-6 py-10 text-center text-[12.5px] leading-relaxed text-ink-faint">
              {sp.q && allScans.length > 0 ? "No scan matches that search." : "No scans yet."}
              <br />
              A scan keeps its results for seven days, then clears itself.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {scans.map((s) => (
                <li key={s.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-medium">{s.title}</p>
                      <p className="mt-0.5 text-[11.5px] text-ink-faint">
                        {s.criteria.slice(0, 4).join(" · ")}
                        {s.criteria.length > 4 ? ` · +${s.criteria.length - 4} more` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[12.5px] tabular">
                        {s.matched} of {s.processed}
                        <span className="text-ink-faint"> matched</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {s.status === "completed" ? relDays(s.createdAt) : s.status}
                      </p>
                    </div>
                  </div>
                  {s.processed < s.total && (
                    <p className="mt-1.5 text-[11px] text-ink-faint">
                      {s.processed} of {s.total} read so far.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Pager page={page} pageSize={PAGE_SIZE} total={matching.length} href={pageLink("/database/scan", sp)} className="mt-4" />
      </section>

      <p className="mt-6 text-[11.5px] leading-relaxed text-ink-faint">Signed in as {user.name}.</p>
    </main>
  );
}
