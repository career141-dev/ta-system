import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { reviewDecisions, reviewList, reviewRequirements, type ReviewDecision } from "@/lib/review";
import { recordReview } from "../actions";
import { SubmitButton } from "@/components/Submit";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 20;

const CHOICES: { value: ReviewDecision; label: string; on: string }[] = [
  { value: "shortlist", label: "Shortlist", on: "bg-brand text-white border-brand" },
  { value: "maybe", label: "Maybe", on: "bg-warn-soft text-warn border-warn" },
  { value: "reject", label: "Reject", on: "bg-danger-soft text-danger border-danger" },
];

/** Why someone is not a shortlist. One click; it tells the matching which rule to learn. */
const REASONS = [
  "Different work",
  "Wrong industry",
  "Too junior",
  "Too senior",
  "Not enough years",
  "Missing an essential point",
  "CV doesn't say enough",
];

export default async function ReviewJob({
  params,
  searchParams,
}: {
  params: Promise<{ job: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const job = Number((await params).job);
  const ids = reviewList(job);
  const o = repo.openings()[job - 1];
  if (!o || ids.length === 0) notFound();
  const decided = reviewDecisions(user.id, job);
  const client = repo.client(o.clientId);
  const done = ids.filter((id) => decided.has(id)).length;
  const reqs = reviewRequirements(job);
  // Numbered against the whole list, so #12 is #12 on any page or search.
  const matching = ids
    .map((id, i) => ({ id, i }))
    .filter(({ id }) => {
      const c = repo.candidate(id);
      return !!c && matchesQuery(sp.q, c.fullName, c.currentTitle, c.currentEmployer, c.location, ...c.workHistory.map((h) => h.employer));
    });
  const page = pageFrom(sp, matching.length, PAGE_SIZE);

  return (
    <main className="mx-auto w-full max-w-[920px] px-6 py-8">
      <Link href="/review" className="text-[12px] text-ink-faint hover:underline">← All review lists</Link>
      <div className="sticky top-0 z-10 -mx-6 mt-2 border-b border-rule bg-paper/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-[19px] font-semibold tracking-tight">{o.title}</h1>
          <span className="tabular text-[12.5px] font-medium text-ink-soft">{done} of {ids.length} reviewed</span>
        </div>
        <div className="text-[12px] text-ink-faint">{client?.name} · {o.locations.join(", ")}</div>
      </div>

      {reqs && (
        <section className="mt-4 rounded-xl border border-brand-line bg-brand-soft/40 px-5 py-4 text-[12.5px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13.5px] font-semibold">Judge against this list</h2>
            <span className="text-[11px] text-ink-faint">Requirements {reqs.version}</span>
          </div>
          <p className="mt-1 text-ink-soft">{reqs.summary}</p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Essential</div>
              <ul className="mt-1 list-disc space-y-1 pl-4">{reqs.essential.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Preferred (ranks higher, never rejects)</div>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-soft">{reqs.preferred.map((e) => <li key={e}>{e}</li>)}</ul>
              <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Level</div>
              <p className="mt-1 text-ink-soft">{reqs.level}</p>
            </div>
          </div>
          <p className="mt-3 border-t border-rule pt-2 text-ink-soft">
            <b>Shortlist</b> = clear evidence for every essential point. <b>Reject</b> = the CV contradicts an essential point, or it is different work.
            <b> Maybe</b> = the CV is silent on an essential point (someone would need to ask). {reqs.notSuitability}
          </p>
        </section>
      )}

      <details className="mt-4 rounded-xl border border-rule bg-surface px-5 py-3 text-[12.5px]">
        <summary className="cursor-pointer font-medium">The job description</summary>
        <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-ink-soft">{o.jdMarkdown}</pre>
      </details>

      <div className="mt-5 flex flex-col gap-4">
        {sp.q && matching.length === 0 && (
          <p className="py-10 text-center text-[12.5px] text-ink-faint">Nobody on this list matches that search.</p>
        )}
        {slicePage(matching, page, PAGE_SIZE).map(({ id, i }) => {
          const c = repo.candidate(id);
          if (!c) return null;
          const mine = decided.get(id);
          const cv = repo.cvTextFor(id) ?? "";
          return (
            <section key={id} id={`p${i + 1}`} className={`rounded-xl border bg-surface px-5 py-4 ${mine ? "border-rule" : "border-rule-strong"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">#{i + 1}</div>
                  <div className="text-[15px] font-semibold">{c.fullName}</div>
                  <div className="text-[13px] text-ink-soft">
                    {c.currentTitle ?? "Title not read"}{c.currentEmployer ? ` · ${c.currentEmployer}` : ""}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-faint">
                    {c.totalExperienceYears != null ? `${Math.round(c.totalExperienceYears)} years` : "Years not read"}
                    {c.location ? ` · ${c.location}` : ""}
                    {c.educationDegree ? ` · ${c.educationDegree}` : ""}
                  </div>
                </div>
                <form action={recordReview} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="job" value={job} />
                  <input type="hidden" name="candidateId" value={id} />
                  {CHOICES.map((ch) => (
                    <SubmitButton
                      key={ch.value}
                      name="decision"
                      value={ch.value}
                      tone={mine?.decision === ch.value && ch.value === "shortlist" ? "light" : "dark"}
                      className={`rounded-lg border px-3.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-60 ${
                        mine?.decision === ch.value ? ch.on : "border-rule bg-surface text-ink hover:bg-paper"
                      }`}
                    >
                      {ch.label}
                    </SubmitButton>
                  ))}
                </form>
              </div>

              {mine && mine.decision !== "shortlist" && (
                <form action={recordReview} className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                  <input type="hidden" name="job" value={job} />
                  <input type="hidden" name="candidateId" value={id} />
                  <input type="hidden" name="decision" value={mine.decision} />
                  <span className="mr-1 text-ink-faint">Main reason:</span>
                  {REASONS.map((r) => (
                    <SubmitButton
                      key={r}
                      name="note"
                      value={r}
                      tone={mine.note === r ? "light" : "dark"}
                      className={`rounded-full border px-2.5 py-0.5 disabled:opacity-60 ${mine.note === r ? "border-ink bg-ink text-paper" : "border-rule text-ink-soft hover:bg-paper"}`}
                    >
                      {r}
                    </SubmitButton>
                  ))}
                </form>
              )}

              {c.workHistory.length > 0 && (
                <ul className="mt-3 grid gap-0.5 text-[12.5px] text-ink-soft">
                  {c.workHistory.slice(0, 6).map((h, k) => (
                    <li key={k}>
                      <span className="text-ink">{h.title}</span> — {h.employer}
                      <span className="text-ink-faint"> {h.fromYear ? `${h.fromYear}–${h.toYear ?? "now"}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
              {c.skills.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.skills.slice(0, 14).map((s) => (
                    <span key={s} className="rounded bg-tag px-1.5 py-0.5 text-[11px] text-ink-soft">{s}</span>
                  ))}
                </div>
              )}
              {cv && (
                <details className="mt-3 text-[12.5px]">
                  <summary className="cursor-pointer text-accent">Read the CV</summary>
                  <pre className="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg bg-paper p-3 font-sans text-[12px] leading-relaxed text-ink-soft">{cv}</pre>
                </details>
              )}
            </section>
          );
        })}
      </div>
      <Pager page={page} pageSize={PAGE_SIZE} total={matching.length} href={pageLink(`/review/${job}`, sp)} />
      <p className="mt-6 text-center text-[12px] text-ink-faint">Decisions save as you click. Change any of them at any time.</p>
    </main>
  );
}
