/**
 * "Show me placements by TA this quarter" → a `ReportSpec`.
 *
 * The model never sees a number and never returns one. It is handed the field
 * catalogue and a sentence, and it returns a query. Everything it sends back is
 * then checked against the catalogue and anything unrecognised is dropped, so a
 * hallucinated column name becomes a missing column rather than a wrong figure.
 *
 * If the model is unavailable the page still works — the builder underneath is
 * the real interface, and this is a faster way to reach the same spec.
 */

import { gemini } from "./ai";
import type { User } from "@/data/types";
import { isTa } from "@/lib/auth";
import {
  AGGS, DATASETS, DEFAULT_SPEC, OPS, PERIODS,
  PRESETS, SHARED_TA_JOB_FIELDS,
  datasetFor,
  type Agg, type DatasetKey, type FilterOp, type ReportSpec,
} from "./reporting";

function catalogue(): string {
  return DATASETS.map((d) => {
    const fields = d.fields.map((f) => `${f.key} (${f.type}) — ${f.label}`).join("\n    ");
    return `dataset "${d.key}" — ${d.note}\n  default date field: ${d.dateField}\n  fields:\n    ${fields}`;
  }).join("\n\n");
}

const PROMPT = `You turn a recruiter's question into a report query. You never answer the question yourself and you never produce figures.

Return ONLY a JSON object, no prose and no code fence, shaped:
{
  "dataset": "openings" | "candidates" | "outreach",
  "columns": [field keys],            // detail columns; leave [] when grouping
  "filters": [{"field": key, "op": op, "value": string}],
  "groupBy": field key or null,
  "metrics": [{"field": key, "agg": agg}],
  "sort": {"field": key or "agg:field", "dir": "asc"|"desc"} or null,
  "period": ${PERIODS.map((p) => `"${p.key}"`).join(" | ")},
  "dateField": field key or null,     // which date the period measures
  "bucket": "day" | "week" | "month" | "quarter" | null,   // step size when groupBy is a date
  "title": "a short name for this report"
}

ops: ${OPS.map((o) => `${o.op} (${o.label})`).join(", ")}
aggs: ${AGGS.map((a) => `${a.agg} (${a.label})`).join(", ")}

Rules:
- Use only the field keys listed below, exactly as spelled. Never invent one.
- A question about "how many X by Y" is groupBy Y with a count metric.
- A question listing people or roles is a detail report: set columns, leave groupBy null.
- For a TA's job-by-job progress or performance, use ta_jobs and the activity columns from the Master Sheet. Other openings reports stay one row per job.
- When the question names a period ("this month", "last quarter"), pick the closest of the allowed periods.
- When the question names a person, a client or a status, make it a filter rather than a column.
- A question about change over time ("by month", "trend", "since June", "each week") groups by a DATE field and sets a bucket. Pick the date that matches: when something was added, shortlisted, assigned or closed.
- Prefer four to eight columns. Put the most identifying one first.

The datasets:

${catalogue()}`;

export interface AskResult {
  ok: boolean;
  spec?: ReportSpec;
  title?: string;
  /** What was thrown away, so the TA can see the model overreached. */
  dropped: string[];
  error?: string;
}

/** A named-TA request must not depend on the model spelling a name or choosing
 * the right row grain. Resolve only against the roster, never candidate data. */
export function resolveTaPerformanceQuestion(question: string, users: readonly User[]):
  | { kind: "other" }
  | { kind: "unknown" }
  | { kind: "ambiguous"; users: User[] }
  | { kind: "found"; user: User } {
  if (!/\b(progress|performance|worked on|working on)\b/i.test(question)) return { kind: "other" };
  const normalized = question.toLocaleLowerCase().replace(/[’]/g, "'");
  const roster = users.filter(isTa);
  const full = roster.filter((user) => normalized.includes(user.name.toLocaleLowerCase()));
  if (full.length === 1) return { kind: "found", user: full[0]! };
  if (full.length > 1) return { kind: "ambiguous", users: full };
  const first = roster.filter((user) => {
    const token = user.name.split(/\s+/)[0]?.toLocaleLowerCase();
    return Boolean(token && normalized.split(/[^\p{L}]+/u).includes(token));
  });
  if (first.length === 1) return { kind: "found", user: first[0]! };
  if (first.length > 1) return { kind: "ambiguous", users: first };
  const looksNamed = /\b(?:progress|performance)\s+(?:of|for)\s+(?:TA\s+)?[A-Z][a-z]+\b/.test(question) ||
    /\b[A-Z][a-z]+['’]s\s+(?:progress|performance)\b/.test(question) ||
    /\bTA\s+[A-Z][a-z]+\b/.test(question);
  return looksNamed ? { kind: "unknown" } : { kind: "other" };
}

export function taPerformanceSpec(userId: string, period: ReportSpec["period"] = "all"): ReportSpec {
  return {
    ...PRESETS[0]!.spec,
    subjectTaId: userId,
    period,
    columns: [...PRESETS[0]!.spec.columns, ...(period === "all" ? [] : [
      "eyeMarkedDateUnknown", "internalShortlistDateUnknown", "externalShortlistDateUnknown",
    ])],
  };
}

/** Everything below is the guard: the model proposes, the catalogue disposes. */
export function coerce(raw: unknown): { spec: ReportSpec; title?: string; dropped: string[] } {
  const dropped: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;

  const dataset = (DATASETS.some((d) => d.key === r.dataset) ? r.dataset : "openings") as DatasetKey;
  const ds = datasetFor(dataset);
  const known = new Set(ds.fields.map((f) => f.key));
  const keep = (k: unknown, where: string): string | null => {
    const key = String(k ?? "");
    if (known.has(key)) return key;
    if (key) dropped.push(`${where}: ${key}`);
    return null;
  };

  const columns = Array.isArray(r.columns)
    ? (r.columns.map((c) => keep(c, "column")).filter(Boolean) as string[])
    : [];

  const filters = Array.isArray(r.filters)
    ? r.filters
        .map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          const field = keep(o.field, "filter");
          const op = OPS.some((x) => x.op === o.op) ? (o.op as FilterOp) : "contains";
          return field ? { field, op, value: String(o.value ?? "") } : null;
        })
        .filter(Boolean) as ReportSpec["filters"]
    : [];

  const groupBy = r.groupBy ? keep(r.groupBy, "group") : null;

  const metrics = Array.isArray(r.metrics)
    ? (r.metrics
        .map((m) => {
          const o = (m ?? {}) as Record<string, unknown>;
          const field = keep(o.field, "metric");
          const agg = AGGS.some((x) => x.agg === o.agg) ? (o.agg as Agg) : "count";
          if (dataset === "ta_jobs" && field && SHARED_TA_JOB_FIELDS.has(field) && agg !== "count_distinct") {
            dropped.push(`metric: ${field} is shared by the job`);
            return null;
          }
          return field ? { field, agg } : null;
        })
        .filter(Boolean) as ReportSpec["metrics"])
    : [];

  // A sort may target a metric column ("sum:placed"), which is not a field.
  let sort: ReportSpec["sort"] = null;
  if (r.sort && typeof r.sort === "object") {
    const o = r.sort as Record<string, unknown>;
    const f = String(o.field ?? "");
    const metricKeys = new Set(metrics.map((m) => `${m.agg}:${m.field}`));
    if (known.has(f) || metricKeys.has(f)) {
      sort = { field: f, dir: o.dir === "asc" ? "asc" : "desc" };
    } else if (f) {
      dropped.push(`sort: ${f}`);
    }
  }

  const period = PERIODS.some((p) => p.key === r.period) ? (r.period as ReportSpec["period"]) : "all";
  const bucket = ["day", "week", "month", "quarter"].includes(String(r.bucket))
    ? (r.bucket as ReportSpec["bucket"])
    : undefined;
  const dateField = r.dateField && known.has(String(r.dateField)) ? String(r.dateField) : undefined;

  return {
    spec: {
      ...DEFAULT_SPEC,
      dataset,
      columns: groupBy ? [] : columns,
      filters,
      groupBy,
      metrics,
      sort,
      period,
      dateField,
      bucket,
    },
    title: typeof r.title === "string" ? r.title.slice(0, 80) : undefined,
    dropped,
  };
}

export async function askForReport(question: string): Promise<AskResult> {
  const res = await gemini("parse", `${PROMPT}\n\nThe question: ${question}`, {
    maxTokens: 1200,
    temperature: 0,
  });
  if (!res.ok) return { ok: false, dropped: [], error: res.reason };

  const text = res.text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some models wrap the object in a sentence; take the outermost braces.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, dropped: [], error: "bad_response" };
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return { ok: false, dropped: [], error: "bad_response" };
    }
  }

  const { spec, title, dropped } = coerce(parsed);
  return { ok: true, spec, title, dropped };
}
