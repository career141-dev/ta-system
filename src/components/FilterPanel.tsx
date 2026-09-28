import Form from "next/form";
import type { ListFilters } from "./CandidateList";

/**
 * Recruiter keeps filters open as a rail rather than behind a button, because
 * they are used constantly on a list view and a modal makes you lose your place.
 *
 * Every filter here works. The seven that used to sit under a "Phase 3" heading
 * doing nothing all read fields the candidate record already carries — past
 * companies is the work history, and the rest are single columns — so they are
 * wired rather than listed. Each one offers what the data actually contains,
 * and matches on a substring: a TA types "cargills", not the registered name.
 */
export interface FilterOptions {
  companies: string[];
  past: string[];
  skills: string[];
  schools: string[];
  industries: string[];
  titles: string[];
  nationalities: string[];
}

const MORE: { name: keyof ListFilters; label: string; from: keyof FilterOptions }[] = [
  { name: "company", label: "Company", from: "companies" },
  { name: "past", label: "Past companies", from: "past" },
  { name: "skill", label: "Skills", from: "skills" },
  { name: "school", label: "Schools", from: "schools" },
  { name: "industry", label: "Industries", from: "industries" },
  { name: "title", label: "Job titles", from: "titles" },
  { name: "nationality", label: "Nationality", from: "nationalities" },
];

export function FilterPanel({
  total,
  shown,
  basePath,
  filters,
  options,
}: {
  total: number;
  shown: number;
  basePath: string;
  filters: ListFilters;
  options: FilterOptions;
}) {
  return (
    <aside className="hidden w-[244px] shrink-0 lg:block">
      <Form action={basePath} className="rounded-xl border border-rule bg-surface p-5">
        {/*
          Carry the toolbar's fields through.

          Two GET forms post to the same URL from this page. Whichever one you
          submit, the browser sends only ITS OWN fields — so applying a rail
          filter silently wiped the search box and the sort, and applying the
          toolbar wiped every rail filter. Each form now re-posts the other's
          current values.
        */}
        {/* minExp, maxExp and maxNotice are left out: this rail has its own selector for them, and
            sending both submitted conflicting values (audit finding 38). */}
        {(["q", "sort", "band", "mine"] as const).map((k) =>
          filters[k] ? <input key={k} type="hidden" name={k} value={filters[k]} /> : null,
        )}
        <div className="mb-4 flex items-baseline justify-between">
          <span className="text-[13px] font-semibold">
            {shown} of {total}
          </span>
          <a href={basePath} className="text-[12px] text-ink-soft hover:text-ink">
            Clear
          </a>
        </div>

        <label className="block border-t border-rule pt-4">
          <span className="text-[12.5px] font-medium">Location</span>
          <input
            name="location"
            defaultValue={filters.location ?? ""}
            placeholder="Any"
            className="mt-1.5 w-full rounded-lg border border-rule px-2.5 py-2 text-[12.5px] outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand"
          />
        </label>

        <label className="mt-4 block border-t border-rule pt-4">
          <span className="text-[12.5px] font-medium">Minimum experience</span>
          <div className="relative mt-1.5">
          <select
            name="minExp"
            defaultValue={filters.minExp ?? ""}
            className="w-full cursor-pointer appearance-none rounded-lg border border-rule bg-surface py-2 pl-2.5 pr-9 text-[12.5px] outline-none transition-colors focus:border-brand"
          >
            <option value="">Any</option>
            <option value="5">5+ years</option>
            <option value="10">10+ years</option>
            <option value="15">15+ years</option>
          </select>
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </label>

        <label className="mt-4 block border-t border-rule pt-4">
          <span className="text-[12.5px] font-medium">Maximum experience</span>
          <div className="relative mt-1.5">
          <select
            name="maxExp"
            defaultValue={filters.maxExp ?? ""}
            className="w-full cursor-pointer appearance-none rounded-lg border border-rule bg-surface py-2 pl-2.5 pr-9 text-[12.5px] outline-none transition-colors focus:border-brand"
          >
            <option value="">Any</option>
            <option value="3">Up to 3 years</option>
            <option value="5">Up to 5 years</option>
            <option value="8">Up to 8 years</option>
            <option value="10">Up to 10 years</option>
            <option value="15">Up to 15 years</option>
            <option value="20">Up to 20 years</option>
          </select>
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </label>

        <label className="mt-4 block border-t border-rule pt-4">
          <span className="text-[12.5px] font-medium">Maximum notice</span>
          <div className="relative mt-1.5">
          <select
            name="maxNotice"
            defaultValue={filters.maxNotice ?? ""}
            className="w-full cursor-pointer appearance-none rounded-lg border border-rule bg-surface py-2 pl-2.5 pr-9 text-[12.5px] outline-none transition-colors focus:border-brand"
          >
            <option value="">Any</option>
            <option value="30">30 days or less</option>
            <option value="60">60 days or less</option>
            <option value="90">90 days or less</option>
          </select>
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </label>

        <div className="mt-4 border-t border-rule pt-4">
          <h2 className="text-[12.5px] font-medium">More filters</h2>
          <div className="mt-2.5 flex flex-col gap-3">
            {MORE.map((m) => {
              const list = options[m.from];
              return (
                <label key={m.name} className="block">
                  <span className="text-[11.5px] text-ink-soft">{m.label}</span>
                  <input
                    name={m.name}
                    list={`opt-${m.name}`}
                    defaultValue={(filters[m.name] as string) ?? ""}
                    placeholder="Any"
                    className="mt-1 w-full rounded-lg border border-rule px-2.5 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand"
                  />
                  {/* What the database actually holds, so nobody filters on a
                      spelling that returns nothing. */}
                  <datalist id={`opt-${m.name}`}>
                    {list.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </label>
              );
            })}
          </div>
        </div>

        <button className="mt-5 w-full rounded-full bg-brand py-2 text-[12.5px] font-medium text-white hover:opacity-90">
          Apply filters
        </button>
      </Form>
    </aside>
  );
}
