import Link from "next/link";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { askReport, deleteReport } from "@/app/actions";
import { AskReportForm } from "@/components/AskReportForm";
import { ReportBuilder } from "./ReportBuilder";
import { SaveReport } from "./SaveReport";
import { Confirm } from "@/components/Confirm";
import { Headline, Histogram, Picture, Table } from "./ReportView";
import { sanitizeSpec,
  CHARTS, DATASETS, DEFAULT_SPEC, OPS, PERIODS, PRESETS,
  datasetFor, optionsFor, presetFor, runReport,
  type ChartKind, type ReportSpec,
} from "@/lib/reporting";
import { FAILURE_MESSAGE } from "@/lib/ai";
import type { AiFailure } from "@/lib/ai";
import { primeStore } from "@/data/prime";
import { can } from "@/lib/auth";
import { MasterSheetTable } from "./MasterSheetTable";

/**
 * Reports — rebuilt 12 September.
 *
 * It used to be two fixed workbook views. It is now a query the desk writes:
 * pick what to report on, which columns, which filters, what to group by — or
 * ask for it in a sentence and correct what comes back. The old workbook views
 * survive as presets, so nothing that worked before stopped working.
 *
 * The whole query lives in the URL. A report is therefore a link: bookmark it,
 * send it to the director, reopen it next quarter and it recalculates. The CSV
 * download reads the same string the table does, so the file and the screen
 * cannot disagree.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    spec?: string; preset?: string; report?: string;
    q?: string; name?: string; dropped?: string; askErr?: string; saved?: string;
    chart?: string; kind?: string;
  }>;
}) {
  const sp = await searchParams;
  await primeStore({ allApplications: true });
  const user = await pageUser("report.read");
  const saved = repo.savedReports(user.id);

  // Precedence: an explicit query, then a saved report, then a preset, then the
  // default. Everything resolves to one spec.
  let spec: ReportSpec = DEFAULT_SPEC;
  let title = "Openings";
  if (sp.spec) {
    try {
      spec = sanitizeSpec(JSON.parse(sp.spec), DEFAULT_SPEC);
      title = sp.name ?? "Custom report";
    } catch {
      // Keep the default rather than blanking the page on a malformed link.
    }
  } else if (sp.report) {
    const r = saved.find((x) => x.id === sp.report);
    if (r) {
      spec = sanitizeSpec(r.spec, DEFAULT_SPEC);
      title = r.name;
    }
  } else if (sp.preset) {
    const p = presetFor(sp.preset);
    if (p) {
      spec = p.spec;
      title = p.label;
    }
  } else {
    spec = PRESETS[0].spec;
    title = PRESETS[0].label;
  }

  const ds = datasetFor(spec.dataset);
  const result = runReport(spec);
  const specJson = JSON.stringify(spec);
  const isMasterSheet = title === "Master Sheet" && spec.dataset === "openings" && !spec.groupBy;
  const canEditById = isMasterSheet
    ? Object.fromEntries(result.rows.map((row) => {
        const openingId = String(row.id ?? "");
        return [openingId, can(user, "opening.manage", {
          openingId,
          assignment: repo.assignmentFor(openingId, user.id) ?? null,
        }).ok];
      }))
    : {};

  // Only the enums, and only for this dataset — the pickers offer what the
  // data actually contains rather than a list somebody typed once.
  const options: Record<string, string[]> = {};
  for (const f of ds.fields) {
    if (f.type === "enum") options[f.key] = optionsFor(spec.dataset, f.key);
  }

  // Sorting or re-charting turns a preset into an explicit query, so the name
  // has to travel with it or the report silently becomes "Custom report".
  const keep = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ spec: JSON.stringify(spec), name: title, ...extra });
    if (sp.chart && !extra.chart) q.set("chart", sp.chart);
    if (sp.kind && !extra.kind) q.set("kind", sp.kind);
    return `/reports?${q}`;
  };
  const chartHref = (key: string) => keep({ chart: key });
  const kindHref = (k: ChartKind) => keep({ kind: k });
  const kind: ChartKind = (CHARTS.some((c) => c.key === sp.kind) ? sp.kind : "auto") as ChartKind;

  const sortHref = (key: string) => {
    const dir = spec.sort?.field === key && spec.sort.dir === "desc" ? "asc" : "desc";
    const q = new URLSearchParams({
      spec: JSON.stringify({ ...spec, sort: { field: key, dir } }),
      name: title,
      ...(sp.chart ? { chart: sp.chart } : {}),
      ...(sp.kind ? { kind: sp.kind } : {}),
    });
    return `/reports?${q}`;
  };

  const th = "whitespace-nowrap border-b border-rule px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-soft";
  const td = "whitespace-nowrap border-b border-rule px-3 py-2.5 text-[12px]";

  const histoColumn = spec.groupBy
    ? null
    : result.columns.find((c) => c.key === spec.sort?.field && c.type === "number") ??
      result.columns.find((c) => c.type === "number");

  const groupLabel = spec.groupBy
    ? ds.fields.find((f) => f.key === spec.groupBy)?.label ?? spec.groupBy
    : null;

  return (
    <main className="mx-auto max-w-[1320px] px-4 sm:px-8 pb-16 pt-6 sm:pt-9">
      <header className="mb-7">
        <h1 className="text-[26px] font-semibold tracking-tight">Reports</h1>
        <p className="mt-2 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-soft">
          Ask for what you want, or build it. Every report is a question put to the live records —
          nothing here is a snapshot, and nothing needs maintaining by hand.
        </p>
      </header>

      {/* ── ask ─────────────────────────────────────────────────────────── */}
      <AskReportForm action={askReport} defaultValue={sp.q ?? ""} />

      {sp.askErr && (
        <p className="mb-6 rounded-xl border border-warn/35 bg-warn-soft px-5 py-3.5 text-[12.5px] text-warn">
          {sp.askErr === "empty" ? (
            "Type a question first — for example “roles open more than 30 days”."
          ) : (
            <>
              {FAILURE_MESSAGE[sp.askErr as AiFailure] ?? "That did not come back as a report."}{" "}
              Build it instead — the controls do everything the sentence can.
            </>
          )}
        </p>
      )}

      {sp.dropped && (
        <p className="mb-6 rounded-xl border border-rule bg-paper px-5 py-3.5 text-[12.5px] text-ink-soft">
          Some of that matched nothing the records hold, so it was left out:{" "}
          <span className="text-ink">{sp.dropped}</span>. Everything below comes only from fields
          that exist.
        </p>
      )}

      {/* ── what you are looking at ─────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/reports?preset=${p.key}`}
            title={p.note}
            className={`rounded-full border px-4 py-2 text-[12.5px] transition-colors ${
              title === p.label
                ? "border-navactive bg-navactive text-white"
                : "border-rule bg-surface text-ink-soft hover:border-rule-strong hover:text-ink"
            }`}
          >
            {p.label}
          </Link>
        ))}
        {saved.map((r) => (
          <Link
            key={r.id}
            href={`/reports?report=${r.id}`}
            className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-[12.5px] transition-colors ${
              sp.report === r.id
                ? "border-brand bg-brand-soft font-medium text-brand"
                : "border-brand-line/40 bg-surface text-brand hover:bg-brand-soft"
            }`}
          >
            <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5h8v11l-4-2.6-4 2.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            {r.name}
            {r.shared && r.ownerId !== user.id && (
              <span className="text-[10.5px] opacity-70">{repo.user(r.ownerId)?.name.split(" ")[0]}</span>
            )}
          </Link>
        ))}
      </div>

      {/* ── the report ──────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            {ds.note}
            {spec.period !== "all" && ` · ${PERIODS.find((p) => p.key === spec.period)?.label.toLowerCase()}`}
            {spec.filters.length > 0 &&
              ` · ${spec.filters.length} filter${spec.filters.length === 1 ? "" : "s"}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {sp.report && saved.find((r) => r.id === sp.report)?.ownerId === user.id && (
            <form action={deleteReport}>
              <input type="hidden" name="reportId" value={sp.report} />
              <Confirm
                label="Delete report"
                question="Delete this saved report?"
                className="text-[12px] text-ink-faint transition-colors hover:text-danger"
              />
            </form>
          )}
          <SaveReport spec={specJson} suggested={title} />
          <a
            href={`/api/reports/report.csv?spec=${encodeURIComponent(specJson)}&name=${encodeURIComponent(title)}`}
            className="flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
          >
            <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2v8M5 7.2l3 3 3-3M2.5 13h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Download
          </a>
        </div>
      </div>

      {result.rows.length === 0 ? (
        // The report ran; nobody matched. It used to say only "Nothing
        // matches that", which read as a failure, and not which filters did
        // it (21 Sep). Each filter is named here and can be taken off.
        <section className="rounded-2xl border border-rule bg-surface px-8 py-14 text-center">
          <p className="text-[14px] text-ink-soft">
            <span className="text-brand">✓ Report built</span> — no records match.
          </p>
          {spec.filters.length > 0 || spec.period !== "all" ? (
            <>
              <p className="mx-auto mt-2 max-w-[52ch] text-[12.5px] leading-relaxed text-ink-faint">
                These are narrowing it down. Take one off and it fills in:
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {spec.period !== "all" && (
                  <Link
                    href={`/reports?${new URLSearchParams({ spec: JSON.stringify({ ...spec, period: "all" }), name: title })}`}
                    className="rounded-full border border-rule px-3 py-1 text-[12px] text-ink-soft hover:border-danger/40 hover:text-danger"
                  >
                    Period: {PERIODS.find((p) => p.key === spec.period)?.label ?? spec.period} ×
                  </Link>
                )}
                {spec.filters.map((f, i) => (
                  <Link
                    key={i}
                    href={`/reports?${new URLSearchParams({ spec: JSON.stringify({ ...spec, filters: spec.filters.filter((_, j) => j !== i) }), name: title })}`}
                    className="rounded-full border border-rule px-3 py-1 text-[12px] text-ink-soft hover:border-danger/40 hover:text-danger"
                  >
                    {ds.fields.find((x) => x.key === f.field)?.label ?? f.field} {OPS.find((o) => o.op === f.op)?.label ?? f.op}
                    {f.value ? ` "${f.value}"` : ""} ×
                  </Link>
                ))}
                <Link
                  href={`/reports?${new URLSearchParams({ spec: JSON.stringify({ ...spec, filters: [], period: "all" }), name: title })}`}
                  className="rounded-full bg-tag px-3 py-1 text-[12px] font-medium text-ink hover:bg-rule"
                >
                  Remove all filters
                </Link>
              </div>
            </>
          ) : (
            <p className="mx-auto mt-2 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-faint">There is nothing in this dataset yet.</p>
          )}
        </section>
      ) : (
        <>
          <Headline
            columns={result.columns}
            rows={result.rows}
            matched={result.matched}
            unit={ds.label.toLowerCase()}
            grouped={Boolean(spec.groupBy)}
          />

          {groupLabel ? (
            <Picture
              columns={result.columns}
              rows={result.rows}
              groupLabel={groupLabel}
              order={result.order}
              sequence={result.sequence}
              kind={kind}
              chartKey={sp.chart}
              chartHref={chartHref}
              kindHref={kindHref}
            />
          ) : (
            // Nothing to compare across, so show the shape of the one number
            // that is worth looking at — the spread of notice periods says more
            // than a column of them.
            histoColumn && (
              <Histogram
                values={result.rows.map((r) => Number(r[histoColumn.key])).filter((n) => Number.isFinite(n))}
                label={histoColumn.label}
              />
            )
          )}

          <section className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
            <div className="flex flex-wrap items-center gap-3 border-b border-rule px-7 py-4">
              <h3 className="text-[13.5px] font-semibold">
                {spec.groupBy ? "Every group" : "Every row"}
              </h3>
              <span className="text-[12px] text-ink-faint">
                <span className="tabular">{result.rows.length}</span> shown
                {result.truncated && ` of ${result.matched} — raise the limit to see the rest`}
              </span>
            </div>
            {isMasterSheet ? (
              <MasterSheetTable
                columns={result.columns}
                rows={result.rows}
                spec={spec}
                sortHref={sortHref}
                canEditById={canEditById}
              />
            ) : (
              <Table columns={result.columns} rows={result.rows} spec={spec} sortHref={sortHref} />
            )}
          </section>
        </>
      )}

      <div className="mt-6">
        <ReportBuilder
          spec={spec}
          fields={ds.fields}
          datasets={DATASETS.map((d) => ({ key: d.key, label: d.label, note: d.note }))}
          options={options}
          name={title}
        />
      </div>

      <p className="max-w-[80ch] text-[11.5px] leading-relaxed text-ink-faint">
        The sentence box only writes the question — which records, which columns, which filters.
        Every figure above is counted from those records, so a report can be wrong about what you
        meant but never about what the data says. The question is in the address bar: send the link
        to someone and they see the same report, recalculated for them.
      </p>
    </main>
  );
}
