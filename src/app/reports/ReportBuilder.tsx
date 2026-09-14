"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AGGS, BUCKETS, OPS, PERIODS,
  type Agg, type Bucket, type DatasetKey, type Field, type FilterOp, type ReportSpec,
} from "@/lib/reportSpec";

const chip =
  "rounded-lg border border-rule bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-brand cursor-pointer";

/**
 * The query, built by hand.
 *
 * The spec lives in the URL rather than in component state: a report is then a
 * link you can send to the director, bookmark, or reopen next quarter, and the
 * table is rendered on the server from the same string the CSV download reads.
 * Nothing about a report is hidden inside a session.
 */
export function ReportBuilder({
  spec,
  fields,
  datasets,
  options,
  name,
}: {
  spec: ReportSpec;
  fields: Field[];
  datasets: { key: DatasetKey; label: string; note: string }[];
  /** Enum values present in this dataset, for the filter pickers. */
  options: Record<string, string[]>;
  /** Carried through every change so an edited preset keeps its name. */
  name: string;
}) {
  const router = useRouter();
  // Closed by default: the report is the page, not the form that made it.
  const [open, setOpen] = useState(false);

  const go = (next: ReportSpec) =>
    router.replace(
      `/reports?${new URLSearchParams({ spec: JSON.stringify(next), name })}`,
      { scroll: false },
    );

  const set = (patch: Partial<ReportSpec>) => go({ ...spec, ...patch });
  const typeOf = (k: string) => fields.find((f) => f.key === k)?.type ?? "text";
  const numeric = fields.filter((f) => f.type === "number" || f.type === "date");

  const label = (t: string) => (
    <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-ink-faint">{t}</span>
  );

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-rule bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-7 py-4 text-left transition-colors hover:bg-paper/60"
      >
        <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-ink-faint">
          <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="text-[13.5px] font-semibold">Change what this shows</span>
        <span className="text-[12px] text-ink-faint">
          {spec.groupBy
            ? `${datasets.find((d) => d.key === spec.dataset)?.label}, grouped by ${fields.find((f) => f.key === spec.groupBy)?.label?.toLowerCase()}`
            : `${datasets.find((d) => d.key === spec.dataset)?.label}, ${spec.columns.length} columns`}
          {spec.filters.length > 0 && ` · ${spec.filters.length} filter${spec.filters.length === 1 ? "" : "s"}`}
        </span>
        <svg width={13} height={13} viewBox="0 0 16 16" aria-hidden="true" className="ml-auto opacity-60">
          <path
            d={open ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"}
            fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="flex flex-col gap-5 border-t border-rule px-6 py-5">
          {/* ── what, and over what window ─────────────────────────────── */}
          <div className="flex flex-wrap items-end gap-4">
            <label>
              {label("Report on")}
              <select
                value={spec.dataset}
                onChange={(e) =>
                  // Fields belong to a dataset, so changing it starts clean
                  // rather than carrying columns that no longer exist.
                  go({
                    ...spec,
                    dataset: e.target.value as DatasetKey,
                    columns: [], filters: [], groupBy: null, metrics: [], sort: null, dateField: undefined,
                  })
                }
                className={chip}
              >
                {datasets.map((d) => (
                  <option key={d.key} value={d.key}>{d.label}</option>
                ))}
              </select>
            </label>

            <label>
              {label("Period")}
              <select value={spec.period} onChange={(e) => set({ period: e.target.value as ReportSpec["period"] })} className={chip}>
                {PERIODS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </label>

            {spec.period !== "all" && (
              <label>
                {label("Measured on")}
                <select value={spec.dateField ?? ""} onChange={(e) => set({ dateField: e.target.value || undefined })} className={chip}>
                  <option value="">Default</option>
                  {fields.filter((f) => f.type === "date").map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </label>
            )}

            <label>
              {label("Group by")}
              <select
                value={spec.groupBy ?? ""}
                onChange={(e) => set({ groupBy: e.target.value || null, sort: null })}
                className={chip}
              >
                <option value="">Nothing — list the rows</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                    {f.type === "date" ? " (over time)" : ""}
                  </option>
                ))}
              </select>
            </label>

            {/* Grouping on a date without a step gives 172 groups of one. */}
            {typeOf(spec.groupBy ?? "") === "date" && (
              <label>
                {label("Step")}
                <select
                  value={spec.bucket ?? "month"}
                  onChange={(e) => set({ bucket: e.target.value as Bucket })}
                  className={chip}
                >
                  {BUCKETS.map((b) => (
                    <option key={b.key} value={b.key}>{b.label}</option>
                  ))}
                </select>
              </label>
            )}

            <label>
              {label("Show at most")}
              <select value={spec.limit} onChange={(e) => set({ limit: Number(e.target.value) })} className={chip}>
                {[50, 100, 500, 2000].map((n) => (
                  <option key={n} value={n}>{n} rows</option>
                ))}
              </select>
            </label>
          </div>

          {/* ── columns, or metrics when grouped ───────────────────────── */}
          {spec.groupBy ? (
            <div>
              {label("Work out")}
              <div className="flex flex-col gap-2">
                {spec.metrics.map((m, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select
                      value={m.agg}
                      onChange={(e) => {
                        const next = [...spec.metrics];
                        next[i] = { ...m, agg: e.target.value as Agg };
                        set({ metrics: next });
                      }}
                      className={chip}
                    >
                      {AGGS.filter((a) => a.types.includes(typeOf(m.field))).map((a) => (
                        <option key={a.agg} value={a.agg}>{a.label}</option>
                      ))}
                    </select>
                    <select
                      value={m.field}
                      onChange={(e) => {
                        const next = [...spec.metrics];
                        next[i] = { ...m, field: e.target.value };
                        set({ metrics: next });
                      }}
                      className={chip}
                    >
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => set({ metrics: spec.metrics.filter((_, n) => n !== i) })}
                      className="text-[12px] text-ink-faint hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    set({ metrics: [...spec.metrics, { field: numeric[0]?.key ?? spec.groupBy!, agg: "sum" }] })
                  }
                  className="self-start text-[12px] font-medium text-brand hover:underline"
                >
                  + Another figure
                </button>
                {spec.metrics.length === 0 && (
                  <p className="text-[11.5px] text-ink-faint">
                    With none set it counts the rows in each group.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div>
              {label("Columns")}
              <div className="flex flex-wrap gap-1.5">
                {fields.map((f) => {
                  const on = spec.columns.includes(f.key);
                  return (
                    <button
                      key={f.key}
                      onClick={() =>
                        set({
                          columns: on
                            ? spec.columns.filter((k) => k !== f.key)
                            : [...spec.columns, f.key],
                        })
                      }
                      className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                        on
                          ? "border-brand bg-brand-soft font-medium text-brand"
                          : "border-rule text-ink-soft hover:border-rule-strong hover:text-ink"
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── filters ────────────────────────────────────────────────── */}
          <div>
            {label("Only include")}
            <div className="flex flex-col gap-2">
              {spec.filters.map((f, i) => {
                const t = typeOf(f.field);
                const opts = options[f.field] ?? [];
                const patch = (p: Partial<typeof f>) => {
                  const next = [...spec.filters];
                  next[i] = { ...f, ...p };
                  set({ filters: next });
                };
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select value={f.field} onChange={(e) => patch({ field: e.target.value, value: "" })} className={chip}>
                      {fields.map((x) => (
                        <option key={x.key} value={x.key}>{x.label}</option>
                      ))}
                    </select>
                    <select value={f.op} onChange={(e) => patch({ op: e.target.value as FilterOp })} className={chip}>
                      {OPS.filter((o) => o.types.includes(t)).map((o) => (
                        <option key={o.op} value={o.op}>{o.label}</option>
                      ))}
                    </select>
                    {f.op !== "is_empty" && f.op !== "not_empty" && (
                      <>
                        <input
                          value={f.value}
                          onChange={(e) => patch({ value: e.target.value })}
                          list={opts.length ? `opt-${f.field}-${i}` : undefined}
                          placeholder={t === "date" ? "2026-09-01" : "value"}
                          className="w-[190px] rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[12px] outline-none focus:border-brand"
                        />
                        {opts.length > 0 && (
                          <datalist id={`opt-${f.field}-${i}`}>
                            {opts.map((v) => (
                              <option key={v} value={v} />
                            ))}
                          </datalist>
                        )}
                      </>
                    )}
                    <button
                      onClick={() => set({ filters: spec.filters.filter((_, n) => n !== i) })}
                      className="text-[12px] text-ink-faint hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() =>
                  set({ filters: [...spec.filters, { field: fields[0].key, op: "contains", value: "" }] })
                }
                className="self-start text-[12px] font-medium text-brand hover:underline"
              >
                + Add a filter
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
