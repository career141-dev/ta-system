import Link from "next/link";
import type { OpeningRequirements } from "@/data/types";

/**
 * The job details at a glance, for the Overview.
 *
 * The full form (seventeen fields, three tag lists) sat on the Overview and
 * pushed the pipeline below the fold; testers asked for it on the Job
 * description page with the JD it is read from (21 Sep). The Overview keeps
 * the facts people check, and one link to change them.
 */
export function JobDetailsSummary({ openingId, requirements: r }: { openingId: string; requirements: OpeningRequirements }) {
  const years =
    r.experienceMinYears != null || r.experienceMaxYears != null
      ? r.experienceMaxYears != null
        ? `${r.experienceMinYears ?? 0}–${r.experienceMaxYears} years`
        : `${r.experienceMinYears}+ years`
      : null;
  const money = (n: number) => (n >= 1000 ? `${Math.round(n / 1000).toLocaleString()}K` : n.toLocaleString());
  const salary =
    r.salaryMin != null
      ? `${r.salaryCurrency ?? ""} ${money(r.salaryMin)}${r.salaryMax != null ? ` – ${money(r.salaryMax)}` : "+"}`.trim()
      : null;
  const seniority = r.seniorityLevel && r.seniorityLevel !== "other"
    ? r.seniorityLevel.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
    : null;

  const facts: [string, string | null][] = [
    ["Seniority", seniority],
    ["Experience", years],
    ["Salary", salary],
    ["Location", r.location],
    ["Industry", r.clientIndustry && r.clientIndustry !== "Other" ? r.clientIndustry : null],
  ];
  const shown = facts.filter(([, v]) => v);
  const skills = r.requiredSkills.slice(0, 6);

  return (
    <section className="mb-8 rounded-2xl border border-rule bg-surface px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Job details</h2>
        <Link href={`/openings/${openingId}/jd#job-details`} className="text-[12.5px] font-medium text-brand hover:underline">
          Edit job details →
        </Link>
      </div>
      {r.status === "extracting" ? (
        <p className="mt-2 text-[12.5px] text-ink-faint">Reading the details from the JD…</p>
      ) : shown.length === 0 && skills.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-faint">Not filled in yet — they are read from the JD once it is written.</p>
      ) : (
        <>
          {shown.length > 0 && (
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-3 lg:grid-cols-5">
              {shown.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-ink-faint">{k}</dt>
                  <dd className="text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {skills.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {skills.map((s) => (
                <span key={s} className="rounded-md bg-tag px-2 py-[3px] text-[12px]">
                  {s}
                </span>
              ))}
              {r.requiredSkills.length > skills.length && (
                <span className="text-[12px] text-ink-faint">+{r.requiredSkills.length - skills.length} more</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
