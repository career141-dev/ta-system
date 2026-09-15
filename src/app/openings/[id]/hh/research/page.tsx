import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { ProjectHeader } from "../../ProjectHeader";
import { Generate, Sources } from "@/components/hh/Generate";
import { runResearch, runBenchmark, pickBenchmark } from "@/app/actions";
import { ResearchField } from "@/components/hh/ResearchField";
import { timeAt } from "@/lib/format";
import { EMPTY_RESEARCH } from "@/data/types";
import { primeStore } from "@/data/prime";

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
  const entries = repo.benchmarks(id);
  const picked = entries.filter((e) => e.isSelected).length;

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Research</h1>
      <ProjectHeader openingId={id} />

      <Generate
        openingId={id}
        action={runResearch}
        label={`Research ${client?.name ?? "the client"}`}
        sub="Fills the fields below from the open web, each with its source. Anything it cannot verify is left empty rather than guessed — and anything you correct by hand survives a re-run."
        err={err}
        hasResult={Boolean(report)}
      />

      <section className="rounded-xl border border-rule bg-surface px-6 py-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <ResearchField openingId={id} name="similarDesignation" label="Similar Designation" value={f.similarDesignation} edited={edited.has("similarDesignation")} />
          <ResearchField openingId={id} name="websiteLink" label="Website Link" value={f.websiteLink} edited={edited.has("websiteLink")} />
        </div>

        <div className="mt-5">
          <ResearchField openingId={id} name="servicesProvider" label="Services Provider" value={f.servicesProvider} list edited={edited.has("servicesProvider")} />
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <ResearchField openingId={id} name="country" label="Country" value={f.country} edited={edited.has("country")} />
          <ResearchField openingId={id} name="location" label="Location" value={f.location} edited={edited.has("location")} />
        </div>

        <div className="mt-5">
          <ResearchField openingId={id} name="competitors" label="Competitors" value={f.competitors} list edited={edited.has("competitors")} />
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <ResearchField openingId={id} name="socialMedia" label="Social Media" value={f.socialMedia} edited={edited.has("socialMedia")} />
        </div>

        <div className="mt-5">
          <ResearchField openingId={id} name="companyOverview" label="Company Overview" value={f.companyOverview} multiline edited={edited.has("companyOverview")} />
        </div>
      </section>

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
              Who holds this job now, before, and at competitors. Tick the ones worth searching
              against — they become target employers in the next Suggestions round.
            </p>
          </div>
          <form action={runBenchmark} className="shrink-0">
            <input type="hidden" name="openingId" value={id} />
            <button className="rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft">
              {entries.length ? "Run again" : "Find them"}
            </button>
          </form>
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
              Nothing benchmarked yet. Four people we can stand behind beats fifteen we cannot.
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
                    <button
                      title={b.isSelected ? "Remove from benchmark" : "Benchmark against this"}
                      className={`grid h-[18px] w-[18px] place-items-center rounded border text-[11px] leading-none transition-colors ${
                        b.isSelected ? "border-brand bg-brand text-white" : "border-rule-strong text-transparent hover:border-brand"
                      }`}
                    >
                      ✓
                    </button>
                  </form>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      {b.linkedinUrl ? (
                        <a href={b.linkedinUrl} target="_blank" rel="noreferrer" className="text-[13.5px] font-semibold text-accent hover:underline">
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
                      <a href={b.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11.5px] text-accent hover:underline">
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