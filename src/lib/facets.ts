import type { Candidate } from "@/data/types";
import { levelKey } from "@/lib/levels";
import type { SearchParams } from "@/lib/query";

/**
 * Filters beside the Database results (29 Oct): experience as a range, then
 * tick lists for job title, place, notice period, availability and industry.
 *
 * Strict by design. A filter hides everyone it does not match, even when that
 * leaves one or two people; clearing it brings the list back. Within one tick
 * list several ticks are OR, across filters (and Level, and the range) AND. The
 * count on an option is what ticking it would give with every other filter
 * applied, so a count is never a promise the list cannot keep.
 *
 * All of it is in memory over the rows the page already holds (the engine's
 * list, 400 at most), so a filter is a re-render from the held answer, not a
 * new search.
 */

export const EXPERIENCE_MAX = 30;

export type FacetRow = { candidate: Candidate; signals: { kind: string }[] };
type Key = { key: string; label: string };

export type Facet = {
  param: string;
  label: string;
  keysOf: (r: FacetRow) => Key[];
  /** Fixed options in their own order, or by count when absent. */
  fixed?: Key[];
};

const NOTICE: Key[] = [
  { key: "0", label: "Immediate" },
  { key: "30", label: "Up to 30 days" },
  { key: "60", label: "31 – 60 days" },
  { key: "90", label: "Over 60 days" },
  { key: "x", label: "Not stated" },
];
const AVAILABILITY: Key[] = [
  { key: "free", label: "Free to approach" },
  { key: "in_pipeline", label: "Already in a pipeline" },
  { key: "placed", label: "Placed by us before" },
];

/** "Sr. Accountant" and "sr accountant" are one title. */
export function titleKey(title: string | null | undefined): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9+#&\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function cityOf(location: string | null | undefined): string {
  return (location ?? "").split(",")[0].trim();
}

function noticeKey(days: number | null | undefined): string {
  if (days == null) return "x";
  return days <= 14 ? "0" : days <= 30 ? "30" : days <= 60 ? "60" : "90";
}

export const FACETS: Facet[] = [
  {
    param: "jt",
    label: "Job title",
    keysOf: (r) => {
      const key = titleKey(r.candidate.currentTitle);
      return key ? [{ key, label: (r.candidate.currentTitle ?? "").trim() }] : [];
    },
  },
  {
    param: "loc",
    label: "Location",
    keysOf: (r) => {
      const city = cityOf(r.candidate.location);
      return city ? [{ key: city.toLowerCase(), label: city }] : [];
    },
  },
  {
    param: "np",
    label: "Notice period",
    fixed: NOTICE,
    keysOf: (r) => [NOTICE.find((n) => n.key === noticeKey(r.candidate.noticePeriodDays))!],
  },
  {
    param: "av",
    label: "Availability",
    fixed: AVAILABILITY,
    keysOf: (r) => AVAILABILITY.filter((a) => r.signals.some((s) => s.kind === a.key)),
  },
  {
    param: "ind",
    label: "Industry",
    keysOf: (r) =>
      [...new Set((r.candidate.industries ?? []).map((i) => i.trim()).filter(Boolean))].map((i) => ({ key: i.toLowerCase(), label: i })),
  },
];

export type Picked = {
  /** Years, inclusive; null when the slider is at its full width. */
  range: [number, number] | null;
  ticks: Map<string, Set<string>>;
  levels: ReadonlySet<string>;
};

const all = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter(Boolean);

export function pickedFrom(sp: SearchParams, levels: ReadonlySet<string>): Picked {
  const n = (v: string | string[] | undefined, fallback: number) => {
    const x = Number(all(v)[0]);
    return Number.isFinite(x) && all(v).length ? Math.min(EXPERIENCE_MAX, Math.max(0, Math.round(x))) : fallback;
  };
  const a = n(sp.xmin, 0);
  const b = n(sp.xmax, EXPERIENCE_MAX);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return {
    range: lo <= 0 && hi >= EXPERIENCE_MAX ? null : [lo, hi],
    ticks: new Map(FACETS.map((f) => [f.param, new Set(all(sp[f.param]))])),
    levels,
  };
}

export function anyActive(p: Picked): boolean {
  return !!p.range || p.levels.size > 0 || [...p.ticks.values()].some((s) => s.size > 0);
}

/** "x" is the range, "lvl" is Level, or a facet's param: the one left out of the test. */
export function rowMatches(r: FacetRow, p: Picked, except?: string): boolean {
  if (except !== "lvl" && p.levels.size > 0 && !p.levels.has(levelKey(r.candidate))) return false;
  if (except !== "x" && p.range) {
    const years = r.candidate.totalExperienceYears;
    // Unknown years cannot be shown to be inside a range.
    if (years == null || years < p.range[0] || (p.range[1] < EXPERIENCE_MAX && years > p.range[1])) return false;
  }
  for (const f of FACETS) {
    const picked = p.ticks.get(f.param);
    if (f.param === except || !picked || picked.size === 0) continue;
    if (!f.keysOf(r).some((k) => picked.has(k.key))) return false;
  }
  return true;
}

export type FacetOption = { key: string; label: string; count: number; on: boolean };

export function facetOptions(f: Facet, rows: FacetRow[], p: Picked): FacetOption[] {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const keys = f.keysOf(r);
    for (const k of keys) if (!labels.has(k.key)) labels.set(k.key, k.label);
    if (!rowMatches(r, p, f.param)) continue;
    for (const k of keys) counts.set(k.key, (counts.get(k.key) ?? 0) + 1);
  }
  const on = p.ticks.get(f.param) ?? new Set<string>();
  const known = f.fixed ? f.fixed.map((k) => k.key) : [...labels.keys()];
  const keys = [...new Set([...known, ...on])].filter((k) => (counts.get(k) ?? 0) > 0 || on.has(k));
  const options = keys.map((key) => ({
    key,
    label: labels.get(key) ?? f.fixed?.find((k) => k.key === key)?.label ?? key,
    count: counts.get(key) ?? 0,
    on: on.has(key),
  }));
  return f.fixed ? options : options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** People who pass every other filter but have no years recorded: what a narrowed range hides. */
export function hiddenForUnknownYears(rows: FacetRow[], p: Picked): number {
  return p.range ? rows.filter((r) => r.candidate.totalExperienceYears == null && rowMatches(r, p, "x")).length : 0;
}
