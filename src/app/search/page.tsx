import Link from "next/link";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { storeMode } from "@/data/mode";
import { convexQuery } from "@/lib/convexServer";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  // Load first: knowing who is signed in reads the users table.
  await primeStore({ allApplications: true });
  await pageUser("database.read");
  // The loaded rows are a slice of the database; the people come from the
  // database's own search, then are loaded so the list can name them.
  const ids = storeMode() === "convex" && q.trim().length >= 2 ? await convexQuery<string[]>("ta/candidates:quickSearch", { q }) : [];
  if (ids.length) await primeStore({ allApplications: true, candidateIds: ids });
  const found = repo.search(q, ids);
  const { openings, candidates } = found;
  const clients = repo.clients();

  return (
    <main className="mx-auto max-w-[980px] px-8 py-9">
      <h1 className="text-[24px] font-semibold tracking-tight">
        {q ? <>Results for <span className="text-ink-soft">&ldquo;{q}&rdquo;</span></> : "Search"}
      </h1>
      {!q && <p className="mt-1.5 text-[13px] text-ink-soft">Type a name, a title or a company in the box above.</p>}

      {q && (
        <div className="mt-7 grid gap-8 lg:grid-cols-2">
          <section>
            <h2 className="mb-3 text-[13px] font-semibold">Openings <span className="ml-1 font-normal text-ink-faint">{openings.length}</span></h2>
            <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
              {openings.length === 0 ? <p className="px-6 py-8 text-center text-[12.5px] text-ink-faint">None</p> : (
                <div className="divide-y divide-rule">
                  {openings.map((o) => (
                    <Link key={o.id} href={`/openings/${o.id}`} className="block px-6 py-3.5 hover:bg-paper/60">
                      <p className="text-[13.5px] font-medium">{o.title}</p>
                      <p className="text-[11.5px] text-ink-faint">{clients.find((c) => c.id === o.clientId)?.name} · {o.status.replace("_", " ")}</p>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
          <section>
            <h2 className="mb-3 text-[13px] font-semibold">Candidates <span className="ml-1 font-normal text-ink-faint">{candidates.length}</span></h2>
            <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
              {candidates.length === 0 ? <p className="px-6 py-8 text-center text-[12.5px] text-ink-faint">None</p> : (
                <div className="divide-y divide-rule">
                  {/* Somebody on no opening has no candidate page to open, so
                      they go to their database record rather than a dead link. */}
                  {candidates.map(({ candidate: c, application: a }) => (
                    <Link
                      key={c.id}
                      href={`/candidates/${c.id}`}
                      className="block px-6 py-3.5 hover:bg-paper/60"
                    >
                      <p className="text-[13.5px] font-medium">{c.fullName}</p>
                      <p className="text-[11.5px] text-ink-faint">{c.currentTitle} at {c.currentEmployer}{a ? ` · in ${repo.opening(a.openingId)?.title} for ${clients.find((x) => x.id === repo.opening(a.openingId)?.clientId)?.name}` : ""}</p>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
