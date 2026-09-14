import { cellText, type Column, type Row } from "@/lib/reportSpec";

/**
 * The pictures.
 *
 * Hand-drawn SVG rather than a charting package: the whole set is smaller than
 * the smallest library, it reads the rows the table reads so the two cannot
 * disagree, and it renders on the server — no spinner, no layout jump, and it
 * is in the page a screenshot of the page captures.
 *
 * Every chart takes the same shape: a list of named values, already ordered by
 * the caller. Ordering is a decision about meaning — a trend runs in time, a
 * funnel runs down the pipeline, a ranking runs by size — so it is made once in
 * the engine and never re-guessed here.
 */

export interface Point {
  name: string;
  values: number[];
}

export const fmt = (n: number) =>
  !Number.isFinite(n)
    ? "—"
    : Math.abs(n) >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : Math.abs(n) >= 10_000
        ? `${Math.round(n / 1000)}k`
        : Number.isInteger(n)
          ? n.toLocaleString()
          : n.toFixed(1);

/** Two greens and a slate, so a second series reads as a comparison rather
 *  than as decoration. Semantic colour stays reserved for warnings. */
export const SERIES = ["#165b42", "#4f9e7a", "#7d94a8", "#b8a06a"];

export function points(rows: Row[], group: Column, metrics: Column[], order?: string[]): Point[] {
  const list = rows.map((r) => ({
    name: cellText(r[group.key], group.type),
    values: metrics.map((m) => Number(r[m.key]) || 0),
  }));
  if (!order) return list;
  const at = new Map(order.map((k, i) => [k, i]));
  return [...list].sort((a, b) => (at.get(a.name) ?? 99) - (at.get(b.name) ?? 99));
}

function Legend({ metrics }: { metrics: Column[] }) {
  if (metrics.length < 2) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5">
      {metrics.map((m, i) => (
        <span key={m.key} className="flex items-center gap-1.5 text-[11.5px] text-ink-soft">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: SERIES[i % SERIES.length] }} />
          {m.label}
        </span>
      ))}
    </div>
  );
}

// ─── ranking ─────────────────────────────────────────────────────────────────

export function BarChart({ data, metrics }: { data: Point[]; metrics: Column[] }) {
  const ranked = [...data].sort((a, b) => b.values[0] - a.values[0]).slice(0, 14);
  const max = Math.max(...ranked.flatMap((d) => d.values.map(Math.abs)), 1);
  const total = data.reduce((n, d) => n + d.values[0], 0);

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {ranked.map((d, i) => (
          <div key={d.name + i} className="grid grid-cols-[minmax(80px,180px)_minmax(0,1fr)_auto] items-center gap-4">
            <span className="truncate text-[13px] text-ink-soft" title={d.name}>{d.name}</span>
            <span className="flex flex-col justify-center gap-1">
              {d.values.map((v, n) => (
                <span key={n} className="relative h-6 rounded-md bg-paper">
                  <span
                    className="absolute inset-y-0 left-0 rounded-md"
                    style={{
                      width: `${Math.max((Math.abs(v) / max) * 100, v === 0 ? 0 : 1.5)}%`,
                      background: SERIES[n % SERIES.length],
                      transformOrigin: "left",
                      animation: `growbar .34s cubic-bezier(.22,.9,.3,1) ${Math.min(i * 16, 160)}ms both`,
                    }}
                  />
                </span>
              ))}
            </span>
            <span className="tabular w-[92px] text-right text-[13px] font-medium">
              {fmt(d.values[0])}
              {total > 0 && metrics.length === 1 && (
                <span className="ml-1.5 text-[11px] font-normal text-ink-faint">
                  {Math.round((d.values[0] / total) * 100)}%
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      <Legend metrics={metrics} />
      {data.length > ranked.length && (
        <p className="mt-4 border-t border-rule pt-3 text-[12px] text-ink-faint">
          {data.length - ranked.length} more{" "}
          {ranked[ranked.length - 1].values[0] > 0
            ? `at or below ${fmt(ranked[ranked.length - 1].values[0])}`
            : "with nothing against them"}{" "}
          — all in the table.
        </p>
      )}
    </>
  );
}

// ─── over time, or across a few categories ───────────────────────────────────

export function ColumnChart({ data, metrics }: { data: Point[]; metrics: Column[] }) {
  const shown = data.slice(0, 26);
  const max = Math.max(...shown.flatMap((d) => d.values.map(Math.abs)), 1);
  const W = 1000;
  const H = 260;
  const pad = { l: 44, r: 8, t: 12, b: 34 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const step = plotW / Math.max(shown.length, 1);
  const barW = Math.min(step * 0.68, 54);
  const inner = barW / metrics.length;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[260px] w-full" role="img">
        {ticks.map((t, i) => {
          const y = pad.t + plotH - (t / max) * plotH;
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="var(--color-rule)" strokeWidth={1} />
              <text x={pad.l - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--color-ink-faint)">
                {fmt(t)}
              </text>
            </g>
          );
        })}

        {shown.map((d, i) => (
          <g key={d.name + i}>
            {d.values.map((v, n) => {
              const h = Math.max((Math.abs(v) / max) * plotH, v === 0 ? 0 : 2);
              return (
                <rect
                  key={n}
                  x={pad.l + i * step + (step - barW) / 2 + n * inner}
                  y={pad.t + plotH - h}
                  width={Math.max(inner - 2, 2)}
                  height={h}
                  rx={3}
                  fill={SERIES[n % SERIES.length]}
                >
                  <title>{`${d.name} · ${metrics[n]?.label}: ${fmt(v)}`}</title>
                </rect>
              );
            })}
            {/* Every label when they fit, every other when they do not. */}
            {(shown.length <= 14 || i % 2 === 0) && (
              <text
                x={pad.l + i * step + step / 2}
                y={H - 12}
                textAnchor="middle"
                fontSize="11"
                fill="var(--color-ink-faint)"
              >
                {d.name.length > 11 ? `${d.name.slice(0, 10)}…` : d.name}
              </text>
            )}
          </g>
        ))}
      </svg>
      <Legend metrics={metrics} />
    </>
  );
}

// ─── a trend ─────────────────────────────────────────────────────────────────

export function LineChart({ data, metrics }: { data: Point[]; metrics: Column[] }) {
  const max = Math.max(...data.flatMap((d) => d.values.map(Math.abs)), 1);
  const W = 1000;
  const H = 260;
  const pad = { l: 44, r: 10, t: 14, b: 34 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - (Math.abs(v) / max) * plotH;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[260px] w-full" role="img">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--color-ink-faint)">
              {fmt(t)}
            </text>
          </g>
        ))}

        {metrics.map((m, n) => {
          const pts = data.map((d, i) => `${x(i)},${y(d.values[n])}`).join(" ");
          const colour = SERIES[n % SERIES.length];
          return (
            <g key={m.key}>
              {n === 0 && (
                <polygon
                  points={`${pad.l},${pad.t + plotH} ${pts} ${x(data.length - 1)},${pad.t + plotH}`}
                  fill={colour}
                  opacity={0.1}
                />
              )}
              <polyline points={pts} fill="none" stroke={colour} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
              {data.map((d, i) => (
                <circle key={i} cx={x(i)} cy={y(d.values[n])} r={3.2} fill="var(--color-surface)" stroke={colour} strokeWidth={2}>
                  <title>{`${d.name} · ${m.label}: ${fmt(d.values[n])}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

        {data.map((d, i) =>
          data.length <= 14 || i % Math.ceil(data.length / 10) === 0 ? (
            <text key={i} x={x(i)} y={H - 12} textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">
              {d.name}
            </text>
          ) : null,
        )}
      </svg>
      <Legend metrics={metrics} />
    </>
  );
}

// ─── share of a whole ────────────────────────────────────────────────────────

export function Donut({ data, metrics }: { data: Point[]; metrics: Column[] }) {
  const ranked = [...data].sort((a, b) => b.values[0] - a.values[0]);
  const top = ranked.slice(0, 7);
  const rest = ranked.slice(7).reduce((n, d) => n + d.values[0], 0);
  const slices = rest > 0 ? [...top, { name: "Everything else", values: [rest] }] : top;
  const total = slices.reduce((n, d) => n + d.values[0], 0);
  if (total <= 0) return null;

  const R = 78;
  const r = 50;
  let angle = -Math.PI / 2;
  const arcs = slices.map((d, i) => {
    const sweep = (d.values[0] / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const big = sweep > Math.PI ? 1 : 0;
    const pt = (rad: number, ang: number) => `${100 + rad * Math.cos(ang)},${100 + rad * Math.sin(ang)}`;
    return {
      name: d.name,
      value: d.values[0],
      colour: SERIES[i % SERIES.length],
      // A single slice is a full circle, which an arc path cannot draw.
      d:
        sweep >= Math.PI * 2 - 0.0001
          ? `M ${100 - R},100 a ${R},${R} 0 1,0 ${R * 2},0 a ${R},${R} 0 1,0 ${-R * 2},0 M ${100 - r},100 a ${r},${r} 0 1,1 ${r * 2},0 a ${r},${r} 0 1,1 ${-r * 2},0`
          : `M ${pt(R, a0)} A ${R},${R} 0 ${big},1 ${pt(R, a1)} L ${pt(r, a1)} A ${r},${r} 0 ${big},0 ${pt(r, a0)} Z`,
    };
  });

  return (
    <div className="flex flex-wrap items-center gap-x-10 gap-y-5">
      <svg viewBox="0 0 200 200" className="h-[190px] w-[190px] shrink-0" role="img">
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.colour} fillRule="evenodd">
            <title>{`${a.name}: ${fmt(a.value)}`}</title>
          </path>
        ))}
        <text x="100" y="96" textAnchor="middle" fontSize="26" fontWeight="600" fill="var(--color-ink)">
          {fmt(total)}
        </text>
        <text x="100" y="116" textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">
          {metrics[0]?.label ?? "total"}
        </text>
      </svg>

      <div className="flex min-w-[220px] flex-1 flex-col gap-2">
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: a.colour }} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{a.name}</span>
            <span className="tabular text-[13px] font-medium">{fmt(a.value)}</span>
            <span className="tabular w-[42px] text-right text-[11.5px] text-ink-faint">
              {Math.round((a.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── the pipeline ────────────────────────────────────────────────────────────

export function Funnel({ data }: { data: Point[] }) {
  const steps = data.filter((d) => d.values[0] > 0);
  if (steps.length < 2) return null;

  // Against the biggest step, not the first. These are counts of who is sitting
  // at each stage right now, and a later stage can hold more people than an
  // earlier one — a placement made last year is still placed, while the review
  // queue it passed through is empty again.
  const max = Math.max(...steps.map((d) => d.values[0]));

  return (
    <>
      <div className="flex flex-col">
        {steps.map((d, i) => {
          const prev = i > 0 ? steps[i - 1].values[0] : null;
          const fell = prev !== null && d.values[0] <= prev;
          const conv = fell && prev! > 0 ? Math.round((d.values[0] / prev!) * 100) : null;
          const width = Math.max((d.values[0] / max) * 100, 3);
          return (
            <div key={d.name + i}>
              {i > 0 && (
                <div className="flex items-center gap-2 py-1 pl-[184px]">
                  <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden="true" className="text-ink-faint">
                    <path
                      d={fell ? "M8 3v10M4.5 9.5L8 13l3.5-3.5" : "M8 13V3M4.5 6.5L8 3l3.5 3.5"}
                      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                    />
                  </svg>
                  {/* A percentage over 100 reads as a broken chart, so a step
                      that grows reports the difference instead. */}
                  <span className={`text-[11.5px] ${conv !== null && conv < 40 ? "text-warn" : "text-ink-faint"}`}>
                    {conv !== null
                      ? `${conv}% carry through`
                      : `${fmt(d.values[0] - (prev ?? 0))} more sitting here`}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-[minmax(80px,180px)_minmax(0,1fr)_auto] items-center gap-4">
                <span className="truncate text-[13px] text-ink-soft" title={d.name}>{d.name}</span>
                <span className="relative h-8 rounded-md bg-paper">
                  <span
                    className="absolute inset-y-0 left-0 rounded-md"
                    style={{
                      width: `${width}%`,
                      background: SERIES[0],
                      opacity: 1 - i * (0.45 / Math.max(steps.length - 1, 1)),
                      transformOrigin: "left",
                      animation: `growbar .34s cubic-bezier(.22,.9,.3,1) ${Math.min(i * 22, 180)}ms both`,
                    }}
                  />
                </span>
                <span className="tabular w-[92px] text-right text-[13px] font-medium">
                  {fmt(d.values[0])}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-4 border-t border-rule pt-3 text-[12px] leading-relaxed text-ink-faint">
        Who is sitting at each stage now — not one intake followed through. A later stage can hold
        more people than an earlier one, because a placement stays placed while the queue it came
        through empties again.
      </p>
    </>
  );
}

// ─── the spread of one number ────────────────────────────────────────────────

export function Histogram({ values, label }: { values: number[]; label: string }) {
  const clean = values.filter((n) => Number.isFinite(n));
  if (clean.length < 8) return null;

  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  // Three distinct values is a tally, not a spread — drawing it as one implies
  // a shape that is not there.
  if (hi - lo < 4 || new Set(clean).size < 6) return null;

  const bins = Math.min(12, Math.max(5, Math.round(Math.sqrt(clean.length))));
  const width = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of clean) counts[Math.min(bins - 1, Math.floor((v - lo) / width))] += 1;
  const peak = Math.max(...counts, 1);

  const sorted = [...clean].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return (
    <section className="mb-5 rounded-2xl border border-rule bg-surface px-7 py-6">
      <div className="mb-5 flex flex-wrap items-baseline gap-3">
        <h3 className="text-[14px] font-semibold">How {label.toLowerCase()} is spread</h3>
        <span className="text-[12px] text-ink-faint">
          {fmt(lo)} to {fmt(hi)} · half are {median >= lo ? `under ${fmt(median)}` : ""}
        </span>
      </div>
      <div className="flex h-[130px] items-end gap-1.5">
        {counts.map((n, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="tabular text-[10.5px] text-ink-faint">{n || ""}</span>
            <span
              className="w-full rounded-t-[3px] bg-brand/75"
              style={{ height: `${(n / peak) * 96}px`, minHeight: n ? 3 : 0 }}
              title={`${fmt(lo + i * width)}–${fmt(lo + (i + 1) * width)}: ${n}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-ink-faint">
        <span>{fmt(lo)}</span>
        <span>{fmt(hi)}</span>
      </div>
    </section>
  );
}
