import { CHARTS, cellText, type ChartKind, type Column, type ReportSpec, type Row } from "@/lib/reportSpec";
import { BarChart, ColumnChart, Donut, Funnel, LineChart, fmt, points } from "./charts";

export { Histogram } from "./charts";

/**
 * How a report reads.
 *
 * A grouped report is a comparison, so it is drawn as one: bars, longest first,
 * with the figure on the bar. A detail report is a list, so it stays a table —
 * but a table where the numeric column you are actually looking at carries its
 * own bar, because nineteen columns of bare integers is a spreadsheet, and the
 * point of leaving the spreadsheet was to stop reading like one.
 *
 * Everything is drawn from the rows the engine returned. There is no second
 * calculation here and no library: an SVG of rectangles is smaller than a chart
 * package and cannot disagree with the table beside it.
 */

function numbers(rows: Row[], key: string): number[] {
  return rows.map((r) => Number(r[key])).filter((n) => Number.isFinite(n));
}

// ─── headline ────────────────────────────────────────────────────────────────

/** A grouped column is keyed `agg:field`, which is how the strip knows whether
 *  a figure can honestly be totalled. */
const aggOf = (key: string): string | null => (key.includes(":") ? key.split(":")[0] : null);

export function Headline({
  columns,
  rows,
  matched,
  unit,
  grouped,
}: {
  columns: Column[];
  rows: Row[];
  matched: number;
  unit: string;
  grouped: boolean;
}) {
  const stats: { label: string; value: string; note?: string }[] = [
    grouped
      ? {
          label: rows.length === 1 ? "Group" : "Groups",
          value: String(rows.length),
          note: `from ${matched} ${unit}`,
        }
      : { label: unit.charAt(0).toUpperCase() + unit.slice(1), value: String(matched) },
  ];

  for (const c of columns.filter((x) => x.type === "number").slice(0, 3)) {
    const ns = numbers(rows, c.key);
    if (!ns.length) continue;

    const agg = aggOf(c.key);
    const top = [...rows].sort((a, b) => Number(b[c.key]) - Number(a[c.key]))[0];
    const topName = top ? cellText(top[columns[0].key], columns[0].type) : null;

    // Totalling a column of averages produces a number that means nothing, so
    // those report their range and leave the arithmetic alone.
    if (agg === "avg" || agg === "min" || agg === "max") {
      const lo = Math.min(...ns);
      const hi = Math.max(...ns);
      stats.push({
        label: c.label,
        value: lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`,
        note: topName ? `highest at ${topName}` : undefined,
      });
    } else {
      const total = ns.reduce((a, b) => a + b, 0);
      stats.push({
        label: c.label,
        value: fmt(total),
        note: topName && grouped ? `most at ${topName}` : `${fmt(Math.round((total / ns.length) * 10) / 10)} on average`,
      });
    }
  }

  const shown = stats.slice(0, 4);
  // The track count follows the number of figures, so a report with two does
  // not sit beside two empty cells.
  const cols = ["", "lg:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3", "sm:grid-cols-2 lg:grid-cols-4"][shown.length];

  return (
    <div className={`mb-5 grid gap-px overflow-hidden rounded-2xl border border-rule bg-rule ${cols}`}>
      {shown.map((s) => (
        <div key={s.label} className="bg-surface px-6 py-5">
          <div className="truncate text-[11px] font-medium uppercase tracking-wider text-ink-faint">{s.label}</div>
          <div className="tabular mt-2 text-[30px] font-semibold leading-none tracking-tight">{s.value}</div>
          {s.note && <div className="mt-2 truncate text-[12px] text-ink-soft">{s.note}</div>}
        </div>
      ))}
    </div>
  );
}

// ─── the picture ─────────────────────────────────────────────────────────────

/**
 * Which chart, when nobody has said.
 *
 * The shape of the data decides: a sequence in time is a trend, the pipeline is
 * a funnel, a handful of parts of a whole is a share, and everything else is a
 * ranking. A wrong default here is worse than no chart, because a bar chart of
 * months in alphabetical order looks like an answer.
 */
export function autoChart(
  sequence: "time" | "stage" | null | undefined,
  groups: number,
  metrics: number,
): Exclude<ChartKind, "auto"> {
  if (sequence === "time") return groups > 2 ? "line" : "column";
  if (sequence === "stage") return "funnel";
  if (groups <= 6 && metrics === 1) return "donut";
  if (groups <= 10 && metrics > 1) return "column";
  return "bar";
}

export function Picture({
  columns,
  rows,
  groupLabel,
  order,
  sequence,
  kind,
  chartKey,
  chartHref,
  kindHref,
}: {
  columns: Column[];
  rows: Row[];
  groupLabel: string;
  order?: string[];
  sequence?: "time" | "stage" | null;
  kind: ChartKind;
  chartKey?: string;
  chartHref: (key: string) => string;
  kindHref: (kind: ChartKind) => string;
}) {
  const numericCols = columns.filter((c) => c.type === "number");
  if (numericCols.length === 0 || rows.length === 0) return null;

  const chosen = numericCols.find((c) => c.key === chartKey) ?? numericCols[0];
  const resolved = kind === "auto" ? autoChart(sequence, rows.length, numericCols.length) : kind;
  if (resolved === "none") return null;

  // A trend, a funnel and a column chart can carry several series; a ranking
  // and a share cannot without becoming unreadable.
  const many = resolved === "line" || resolved === "column";
  const series = many ? numericCols.slice(0, 3) : [chosen];
  const data = points(rows, columns[0], series, order);
  const total = data.reduce((n, d) => n + d.values[0], 0);

  return (
    <section className="mb-5 rounded-2xl border border-rule bg-surface px-7 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <h3 className="text-[14px] font-semibold">
          {many && series.length > 1 ? series.map((m) => m.label).join(", ") : chosen.label} by {groupLabel}
        </h3>
        <span className="text-[12px] text-ink-faint">
          {total > 0 && `${fmt(total)} across ${rows.length} ${rows.length === 1 ? "group" : "groups"}`}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {!many && numericCols.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {numericCols.map((c) => (
                <a
                  key={c.key}
                  href={chartHref(c.key)}
                  className={`rounded-full px-2.5 py-1 text-[11.5px] transition-colors ${
                    c.key === chosen.key
                      ? "bg-brand-soft font-medium text-brand"
                      : "text-ink-faint hover:bg-paper hover:text-ink"
                  }`}
                >
                  {c.label}
                </a>
              ))}
            </div>
          )}

          {/* The automatic choice is usually right; this is for when it is not. */}
          <div className="flex gap-0.5 rounded-lg border border-rule p-0.5">
            {CHARTS.filter((c) => c.key !== "none").map((c) => (
              <a
                key={c.key}
                href={kindHref(c.key)}
                title={c.key === "auto" ? "Let the data decide" : c.label}
                className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
                  (kind === "auto" ? "auto" : resolved) === c.key
                    ? "bg-navactive text-white"
                    : "text-ink-faint hover:bg-paper hover:text-ink"
                }`}
              >
                <ChartIcon kind={c.key} />
              </a>
            ))}
          </div>
        </div>
      </div>

      {resolved === "line" && <LineChart data={data} metrics={series} />}
      {resolved === "column" && <ColumnChart data={data} metrics={series} />}
      {resolved === "donut" && <Donut data={data} metrics={series} />}
      {resolved === "funnel" && <Funnel data={data} />}
      {resolved === "bar" && <BarChart data={data} metrics={series} />}
    </section>
  );
}

function ChartIcon({ kind }: { kind: ChartKind }) {
  const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Partial<Record<ChartKind, React.ReactNode>> = {
    auto: <path d="M8 2.5l1.5 3.6 3.6 1.4-3.6 1.4L8 12.5 6.5 8.9 2.9 7.5l3.6-1.4z" {...base} />,
    column: <path d="M3.5 13V7M8 13V3.5M12.5 13v-4" {...base} strokeWidth={1.8} />,
    bar: <path d="M3 4h9M3 8h5.5M3 12h7.5" {...base} strokeWidth={1.8} />,
    line: <path d="M2.5 11l3.5-4 2.5 2 5-6" {...base} />,
    donut: (
      <>
        <circle cx="8" cy="8" r="5.4" {...base} />
        <circle cx="8" cy="8" r="1.9" {...base} />
      </>
    ),
    funnel: <path d="M2.5 3.5h11l-4 5v5l-3-1.6V8.5z" {...base} />,
  };
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

// ─── the rows ────────────────────────────────────────────────────────────────

export function Table({
  columns,
  rows,
  spec,
  sortHref,
}: {
  columns: Column[];
  rows: Row[];
  spec: ReportSpec;
  sortHref: (key: string) => string;
}) {
  // One column gets bars behind its figures: the one being sorted on if it is
  // numeric, otherwise the first. Bars on every column is wallpaper.
  const barKey =
    columns.find((c) => c.key === spec.sort?.field && c.type === "number")?.key ??
    columns.find((c) => c.type === "number")?.key ??
    null;
  const barMax = barKey ? Math.max(...numbers(rows, barKey).map(Math.abs), 1) : 1;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule-strong">
            {columns.map((c, i) => {
              const active = spec.sort?.field === c.key;
              return (
                <th
                  key={c.key}
                  className={`whitespace-nowrap bg-surface px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.05em] ${
                    c.type === "number" ? "text-right" : "text-left"
                  } ${i === 0 ? "sticky left-0 z-10" : ""} ${active ? "text-ink" : "text-ink-faint"}`}
                >
                  <a
                    href={sortHref(c.key)}
                    className={`inline-flex items-center gap-1 hover:text-ink ${c.type === "number" ? "flex-row-reverse" : ""}`}
                  >
                    {c.label}
                    <span className={`text-[8px] ${active ? "opacity-100" : "opacity-0"}`}>
                      {spec.sort?.dir === "asc" ? "▲" : "▼"}
                    </span>
                  </a>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="group border-b border-rule last:border-b-0 hover:bg-brand-soft/40">
              {columns.map((c, n) => {
                const isBar = c.key === barKey;
                const v = Number(r[c.key]);
                const pct = isBar && Number.isFinite(v) ? (Math.abs(v) / barMax) * 100 : 0;
                return (
                  <td
                    key={c.key}
                    className={`relative whitespace-nowrap px-4 py-3 text-[13px] ${
                      c.type === "number" ? "tabular text-right" : ""
                    } ${n === 0 ? "sticky left-0 z-10 bg-surface font-medium group-hover:bg-brand-soft/40" : ""}`}
                  >
                    {isBar && pct > 0 && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-[5px] right-1 rounded-[3px] bg-brand/12"
                        style={{ width: `calc(${pct}% - 8px)`, minWidth: 2 }}
                      />
                    )}
                    <span className="relative">{cellText(r[c.key], c.type)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
