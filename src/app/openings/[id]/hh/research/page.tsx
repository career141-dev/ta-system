import { externalUrl } from "@/lib/url";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { ProjectHeader } from "../../ProjectHeader";
import { Generate, Sources } from "@/components/hh/Generate";
import { runResearchInline, pickBenchmark, correctClientAndRerun } from "@/app/actions";
import { SubmitButton } from "@/components/Submit";
import { BenchmarkButton } from "@/components/hh/BenchmarkButton";
import { ResearchField } from "@/components/hh/ResearchField";
import { timeAt } from "@/lib/format";
import { EMPTY_RESEARCH } from "@/data/types";
import { primeStore } from "@/data/prime";
import { SENIORITY_LABEL, benchmarkByDefault, seniorityOf } from "@/lib/incumbents";

const CONFIDENCE_TONE = {
  high: "bg-brand-soft text-brand",
  medium: "bg-warn-soft text-warn",
  low: "bg-tag text-ink-soft",
} as const;

/**
 * Research — spec §8A.1, laid out to the Figma's Research frame.
 *
 * Named fields rather than a prose report, because a TA scans this repeatedly
 * and prose makes them re-read. Every field is generated with a source and every
 * field is editable; one the search could not verify stays **empty** rather than
 * being filled with something plausible.
 *
 * Benchmarking lives here too, as the Figma has it — who holds this job
 * elsewhere is research about the market, not a separate errand.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string; found?: string; searches?: string }>;
}) {
  const { id } = await params;
  const { err, found, searches } = await searchParams;
  await primeStore({ openingId: id });
  const o = repo.opening(id);
  if (!o) notFound();
  const client = repo.client(o.clientId);
  const report = repo.research(id);
  const f = report?.fields ?? EMPTY_RESEARCH;
  const edited = new Set(report?.editedFields ?? []);
  const rivals = f.competitorProfiles ?? [];
  const entries = repo.benchmarks(id);
  const picked = entries.filter((e) => e.isSelected).length;
  const senior = benchmarkByDefault(o.title);

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Research</h1>
      <ProjectHeader openingId={id} />

      <Generate
        openingId={id}
        action={runResearchInline}
        label={`Research ${client?.name ?? "the client"}${client?.industry ? ` · ${client.industry}` : ""}`}
        sub={`Searches the client and its competitors by the name and industry on the client record, reads their websites, and fills the fields below — each with its source.${senior ? " For this role it also finds who holds it now, for Benchmark." : ""} Anything it cannot find is left empty rather than guessed, and anything you correct by hand survives a re-run.`}
        needs="search"
        err={err}
        hasResult={Boolean(report)}
      />

      {/*
        Which company Research took the client to be, and a way to say it was
        the wrong one (28 Sep: "SQ" was researched as another SQ). What is
        written here is saved on the client, so every job for them uses it.
      */}
      {client && (
        <details className="mb-5 rounded-xl border border-rule bg-surface px-6 py-4" open={!report && !client.researchNotes}>
          <summary className="cursor-pointer text-[12.5px]">
            {report ? (
              <>
                Research took <span className="font-semibold">{client.name}</span> to be{" "}
                {f.websiteLink ? (
                  <a href={externalUrl(f.websiteLink) ?? undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {f.websiteLink.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                ) : (
                  <span className="text-ink-faint">a company with no website found</span>
                )}
                {f.socialMedia && (
                  <>
                    {" · "}
                    <a href={externalUrl(f.socialMedia) ?? undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      LinkedIn
                    </a>
                  </>
                )}
                . <span className="font-medium">Wrong company? Correct it</span>
              </>
            ) : (
              <span className="font-medium">Tell Research who {client.name} is</span>
            )}
          </summary>
          <form action={correctClientAndRerun} className="mt-3">
            <input type="hidden" name="openingId" value={id} />
            <textarea
              name="researchNotes"
              defaultValue={client.researchNotes ?? ""}
              rows={4}
              maxLength={2000}
              placeholder="Paste what you know: the website, the LinkedIn company page, the full company name, what they do, group companies…"
              className="w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-brand"
            />
            <p className="mt-1.5 text-[11.5px] text-ink-faint">
              Saved on the client, so every job for {client.name} uses it. A website or LinkedIn link written here is used as-is.
              Saving runs Research and a new Suggestions round again; suggestions nobody has acted on yet are set aside.
            </p>
            <SubmitButton className="mt-3 rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-60">
              Save and run again
            </SubmitButton>
          </form>
        </details>
      )}

      <section className="rounded-xl border border-rule bg-surface px-6 py-6">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
          <ResearchField openingId={id} name="similarDesignation" label="Similar Designation" value={f.similarDesignation} edited={edited.has("similarDesignation")} />
          <ResearchField openingId={id} name="websiteLink" label="Website Link" value={f.websiteLink} edited={edited.has("websiteLink")} />
        </div>

        <div className="mt-5">
          <ResearchField openingId={id} name="servicesProvider" label="Services Provider" value={f.servicesProvider} list edited={edited.has("servicesProvider")} />
        </div>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
          <ResearchField openingId={id} name="country" label="Country" value={f.country} edited={edited.has("country")} />
          <ResearchField openingId={id} name="location" label="Location" value={f.location} edited={edited.has("location")} />
        </div>

        <div className="mt-5">
          <ResearchField openingId={id} name="competitors" label="Competitors" value={f.competitors} list edited={edited.has("competitors")} />
        </div>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
          <ResearchField openingId={id} name="socialMedia" label="Social Media" value={f.socialMedia} edited={edited.has("socialMedia")} />
        </div>

        <div className="mt-5">
          <ResearchField openingId={id} name="companyOverview" label="Company Overview" value={f.companyOverview} multiline edited={edited.has("companyOverview")} />
        </div>
      </section>

      {rivals.length > 0 && (
        <section className="mt-6 rounded-xl border border-rule bg-surface">
          <div className="border-b border-rule px-6 py-4">
            <h2 className="text-[13px] font-semibold">
              Competitors <span className="ml-1 font-normal text-ink-faint">{rivals.length}</span>
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-soft">
              Named in the search results, then searched and read one by one. Benchmark looks for this role at these companies.
            </p>
          </div>
          <div className="divide-y divide-rule">
            {rivals.map((c) => (
              <div key={c.name} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[13.5px] font-semibold">{c.name}</span>
                  {c.location && <span className="text-[12px] text-ink-faint">{c.location}</span>}
                  <span className="ml-auto flex gap-3 text-[12px]">
                    {c.website ? (
                      <a href={externalUrl(c.website) ?? undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        Website
                      </a>
                    ) : (
                      <span className="text-ink-faint">No website found</span>
                    )}
                    {c.linkedin && (
                      <a href={externalUrl(c.linkedin) ?? undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        LinkedIn
                      </a>
                    )}
                  </span>
                </div>
                {c.whatTheyDo && <p className="mt-1 text-[12.5px]">{c.whatTheyDo}</p>}
                {c.summary && <p className="mt-1 text-[12.5px] text-ink-soft">{c.summary}</p>}
                {!c.whatTheyDo && !c.summary && (
                  <p className="mt-1 text-[12px] text-ink-faint">Their pages did not say what they do.</p>
                )}
                {c.sources.length > 0 && (
                  <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px]">
                    {c.sources.map((s) => (
                      <a key={s.url} href={externalUrl(s.url) ?? undefined} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        {s.title}
                      </a>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {report && (
        <>
          <Sources sources={report.sources} />
          <p className="mt-3 text-[11.5px] text-ink-faint">
            Generated {timeAt(report.generatedAt)} · {report.model} · {report.searches} web{" "}
            {report.searches === 1 ? "search" : "searches"} · check anything going in front of the client
          </p>
        </>
      )}

      <div className="mt-9">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Benchmark</h2>
            <p className="mt-0.5 text-[12px] text-ink-soft">
              Who holds this role now at {client?.name ?? "the client"}, who held it before, and who holds it at the
              competitors — from their own leadership pages and the web. Tick the ones worth searching against — they
              become target employers in the next Suggestions round.
            </p>
          </div>
          <BenchmarkButton openingId={id} again={entries.length > 0} anyway={!senior && entries.length === 0} />
        </div>

        {found !== undefined && (
          <p className="mb-3 text-[11.5px] text-ink-faint">
            {found} sourced {Number(found) === 1 ? "row" : "rows"} kept
            {searches ? ` · ${searches} web searches` : ""} · a named person with no source behind
            them is dropped before it reaches this page
          </p>
        )}

        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          {entries.length === 0 ? (
            <p className="px-8 py-12 text-center text-[12.5px] leading-relaxed text-ink-faint">
              {senior
                ? "Nothing benchmarked yet — Research finds who holds the role when it runs. Four people we can stand behind beats fifteen we cannot."
                : `${o.title} is a ${SENIORITY_LABEL[seniorityOf(o.title)]} role, so Research does not benchmark it. Press Find them anyway if it is needed.`}
            </p>
          ) : (
            <div className="divide-y divide-rule">
              {picked > 0 && (
                <p className="bg-brand-soft/50 px-6 py-2.5 text-[12px] text-brand">
                  {picked} selected — they feed the next Suggestions round
                </p>
              )}
              {entries.map((b) => (
                <div key={b.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-6 py-4">
                  <form action={pickBenchmark} className="pt-0.5">
                    <input type="hidden" name="openingId" value={id} />
                    <input type="hidden" name="entryId" value={b.id} />
                    <SubmitButton
                      tone={b.isSelected ? "light" : "dark"}
                      title={b.isSelected ? "Remove from benchmark" : "Benchmark against this"}
                      className={`h-[18px] w-[18px] rounded border text-[11px] leading-none transition-colors disabled:opacity-60 ${
                        b.isSelected ? "border-brand bg-brand text-white" : "border-rule-strong text-transparent hover:border-brand"
                      }`}
                    >
                      ✓
                    </SubmitButton>
                  </form>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      {b.linkedinUrl ? (
                        <a href={externalUrl(b.linkedinUrl) ?? undefined} target="_blank" rel="noreferrer" className="text-[13.5px] font-semibold text-accent hover:underline">
                          {b.name ?? "Name not established"}
                        </a>
                      ) : (
                        <span className="text-[13.5px] font-semibold">{b.name ?? "Name not established"}</span>
                      )}
                      <span className={`rounded px-1.5 py-[3px] text-[10.5px] font-medium ${CONFIDENCE_TONE[b.confidence]}`}>
                        {b.confidence} confidence
                      </span>
                      <span className="text-[11px] text-ink-faint">
                        {{ incumbent: "holds it now", predecessor: "held it before", competitor: "same role elsewhere" }[b.kind]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[13px]">{b.title} at {b.company}</p>
                    {b.note && <p className="mt-0.5 text-[12px] text-ink-faint">{b.note}</p>}
                    {b.sourceUrl && (
                      <a href={externalUrl(b.sourceUrl) ?? undefined} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11.5px] text-accent hover:underline">
                        {b.sourceTitle ?? b.sourceUrl}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}