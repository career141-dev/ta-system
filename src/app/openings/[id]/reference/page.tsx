import Link from "next/link";
import { repo } from "@/data/store";
import { ProjectHeader } from "../ProjectHeader";
import { StatRow } from "@/components/StatRow";
import { inputClass } from "@/components/form";
import { primeStore } from "@/data/prime";
import { requireSourcingSeat } from "../sourcingGate";
import { STAGE_LABEL } from "@/data/types";
import { VerifyReferee } from "@/components/VerifyReferee";

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
  searchParams: Promise<{ company?: string; cand?: string }>;
}) {
  const { id } = await params;
  const { company = "", cand = "" } = await searchParams;
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);

  // Only the referees of people in Follow-up or further on this opening
  // (21 Sep) — not a search of the whole database.
  const groups = repo.refereesForPipeline(id);
  const shown = cand ? groups.filter((g) => g.app.id === cand) : groups;
  const all = groups.flatMap((g) => g.referees);
  const vault = repo.linkVault(id);
  const targetCompanies = [...new Set(vault.map((v) => v.company).filter(Boolean))] as string[];
  const backchannel = company ? repo.peopleAtCompany(company) : [];
  const withPhone = all.filter((r) => r.phone).length;

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Reference</h1>
      <ProjectHeader openingId={id} />

      <StatRow
        items={[
          { n: all.length, label: "Referees" },
          { n: groups.length, label: "Candidates in Follow-up or later" },
          { n: withPhone, label: "With a number" },
          { n: targetCompanies.length, label: "Target companies" },
        ]}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[1fr_330px]">
        <section className="rounded-2xl border border-rule bg-surface">
          <header className="border-b border-rule px-7 py-5">
            <h2 className="text-[14px] font-semibold">References — for the candidates in Follow-up and after</h2>
            <p className="mt-1 max-w-[64ch] text-[12.5px] leading-relaxed text-ink-soft">
              The referees named on the CVs of people being followed up or shortlisted here. A CV&rsquo;s
              designation can be years old — Verify on LinkedIn checks where they are now.
            </p>
            {groups.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Link
                  href={`/openings/${id}/reference`}
                  className={`rounded-full border px-3 py-1 text-[12px] ${!cand ? "border-navactive bg-navactive text-white" : "border-rule text-ink-soft hover:border-rule-strong"}`}
                >
                  Everyone
                </Link>
                {groups.map((g) => (
                  <Link
                    key={g.app.id}
                    href={`/openings/${id}/reference?cand=${g.app.id}`}
                    className={`rounded-full border px-3 py-1 text-[12px] ${cand === g.app.id ? "border-navactive bg-navactive text-white" : "border-rule text-ink-soft hover:border-rule-strong"}`}
                  >
                    {g.candidate!.fullName} · {g.referees.length}
                  </Link>
                ))}
              </div>
            )}
          </header>

          {groups.length === 0 ? (
            <p className="px-7 py-14 text-center text-[13px] text-ink-faint">
              Nobody is in Follow-up or later on this opening yet. Their referees appear here once they are.
            </p>
          ) : (
            <div className="divide-y divide-rule">
              {shown.map(({ app, candidate: c, referees }) => (
                <div key={app.id} className="px-7 py-5">
                  <p className="text-[13px] font-semibold">
                    <Link href={`/openings/${id}/candidate/${app.id}`} className="text-brand hover:underline">
                      {c!.fullName}
                    </Link>
                    <span className="ml-2 text-[11.5px] font-normal text-ink-faint">{STAGE_LABEL[app.stage]}</span>
                  </p>
                  {referees.length === 0 ? (
                    <p className="mt-2 text-[12.5px] text-ink-faint">No referees on their CV. Ask for two on the next call.</p>
                  ) : (
                    <div className="mt-2 flex flex-col divide-y divide-rule/70">
                      {referees.map((r) => (
                        <div key={r.id} className="flex flex-wrap items-start justify-between gap-5 py-3">
                          <div className="min-w-0 flex-1">
                            <span className="text-[14px] font-medium">{r.name}</span>
                            <p className="mt-1 text-[12.5px]">
                              {r.title ?? "Role not on the CV"}
                              {r.company && (
                                <>
                                  <span className="text-ink-faint"> at </span>
                                  {r.company}
                                </>
                              )}
                              <span className="ml-1.5 text-[11px] text-ink-faint">(from the CV)</span>
                            </p>
                            {r.relationship && <p className="mt-1 text-[12px] text-ink-faint">{r.relationship}</p>}
                          </div>
                          <div className="shrink-0 text-right text-[12.5px]">
                            {r.phone ? (
                              <span className="tabular block">{r.phone}</span>
                            ) : (
                              <span className="block text-ink-faint">No number on file</span>
                            )}
                            <span className="mt-0.5 block text-[11.5px] text-ink-faint">{r.email}</span>
                            <VerifyReferee refereeId={r.id} openingId={id} />
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
                      ))}
                    </div>
                  )}
                </div>
              ))}
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
