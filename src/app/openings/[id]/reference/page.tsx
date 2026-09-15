import Link from "next/link";
import { repo } from "@/data/store";
import { ProjectHeader } from "../ProjectHeader";
import { StatRow } from "@/components/StatRow";
import { inputClass } from "@/components/form";
import { primeStore } from "@/data/prime";

/**
 * Spec §6.1, notebook page 4 — referees named on CVs, made searchable against
 * this opening. Plus the backchannel from pages 1 and 3: given a company, who
 * else in the database works there and could be asked for a number.
 */
export default async function ReferencePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ company?: string }>;
}) {
  const { id } = await params;
  const { company = "" } = await searchParams;
  await primeStore({ openingId: id });

  const ranked = repo.refereesForOpening(id);
  const vault = repo.linkVault(id);
  const targetCompanies = [...new Set(vault.map((v) => v.company).filter(Boolean))] as string[];
  const backchannel = company ? repo.peopleAtCompany(company) : [];
  const withPhone = ranked.filter((r) => r.referee.phone).length;

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Reference</h1>
      <ProjectHeader openingId={id} />

      <StatRow
        items={[
          { n: ranked.length, label: "Relevant referees" },
          { n: withPhone, label: "With a number" },
          { n: targetCompanies.length, label: "Target companies" },
        ]}
      />

      <div className="grid gap-8 xl:grid-cols-[1fr_330px]">
        <section className="rounded-2xl border border-rule bg-surface">
          <header className="border-b border-rule px-7 py-5">
            <h2 className="text-[14px] font-semibold">Referees from CVs in this pool</h2>
            <p className="mt-1 max-w-[64ch] text-[12.5px] leading-relaxed text-ink-soft">
              Only referees with a real tie to this job — they work at a target company, or they
              vouched for someone relevant to it. Each says why it is here.
            </p>
          </header>

          {ranked.length === 0 ? (
            <p className="px-7 py-14 text-center text-[13px] text-ink-faint">
              No referees linked to this job yet. They appear as CVs are read into the pool.
            </p>
          ) : (
            <div className="divide-y divide-rule">
              {ranked.slice(0, 25).map(({ referee: r, why }) => {
                const from = repo.candidate(r.fromCandidateId);
                return (
                  <div key={r.id} className="flex flex-wrap items-start justify-between gap-5 px-7 py-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="text-[14px] font-medium">{r.name}</span>
                      </div>
                      <p className="mt-1 text-[12.5px]">
                        {r.title}
                        <span className="text-ink-faint"> at </span>
                        {r.company}
                      </p>
                      <p className="mt-1.5 text-[12px] text-ink-faint">
                        {r.relationship} to {from?.fullName ?? "a candidate"}
                      </p>
                      <p className="mt-1 text-[12px] text-ink-soft">Here because: {why.join("; ")}.</p>
                    </div>
                    <div className="shrink-0 text-right text-[12.5px]">
                      {r.phone ? (
                        <span className="tabular block">{r.phone}</span>
                      ) : (
                        <span className="block text-ink-faint">No number on file</span>
                      )}
                      <span className="mt-0.5 block text-[11.5px] text-ink-faint">{r.email}</span>
                      {r.company && (
                        <Link
                          href={`/openings/${id}/reference?company=${encodeURIComponent(r.company)}`}
                          className="mt-2 inline-block text-[12px] font-medium text-brand hover:underline"
                        >
                          Who else is there?
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-6">
          <section className="rounded-2xl border border-rule bg-surface p-7">
            <h2 className="text-[14px] font-semibold">Backchannel</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
              Looking for someone&rsquo;s number? Find who else in the database works at their company
              and ask them.
            </p>
            <form method="GET" action={`/openings/${id}/reference`} className="mt-4">
              <input
                name="company"
                defaultValue={company}
                placeholder="Company name"
                className={inputClass}
              />
              <button className="mt-3 w-full rounded-full bg-brand py-2.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90">
                Search
              </button>
            </form>

            {targetCompanies.length > 0 && !company && (
              <div className="mt-5 border-t border-rule pt-4">
                <p className="mb-2.5 text-[11.5px] text-ink-faint">From your link vault:</p>
                <div className="flex flex-wrap gap-1.5">
                  {targetCompanies.slice(0, 6).map((c) => (
                    <Link
                      key={c}
                      href={`/openings/${id}/reference?company=${encodeURIComponent(c)}`}
                      className="rounded-md border border-rule px-2 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-brand-line hover:text-brand"
                    >
                      {c}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {company && (
              <div className="mt-5 border-t border-rule pt-4">
                <p className="mb-3 text-[12.5px]">
                  <span className="font-medium">{backchannel.length}</span>
                  <span className="text-ink-soft"> at {company}</span>
                </p>
                <div className="flex flex-col gap-3.5">
                  {backchannel.length === 0 && (
                    <p className="text-[12px] text-ink-faint">
                      Nobody in the database works there.
                    </p>
                  )}
                  {backchannel.slice(0, 8).map((c) => (
                    <div key={c.id} className="text-[12.5px] leading-relaxed">
                      <span className="font-medium">{c.fullName}</span>
                      <br />
                      <span className="text-ink-soft">{c.currentTitle}</span>
                      <br />
                      <span className="tabular text-ink-faint">{c.phone ?? c.email}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
