/**
 * What a report *is* — the vocabulary, with no way to read a record.
 *
 * Split out of the engine on 12 September because the builder runs in the
 * browser: importing the engine there dragged the JSON store, and `node:fs`
 * with it, into the client bundle. Types, field catalogue, operators and the
 * presets live here; anything that touches data lives in `reporting.ts`.
 */

import { COLOMBO_OFFSET_MS, TIMEZONE } from "./calendar";

// ─── the spec ────────────────────────────────────────────────────────────────

export type DatasetKey = "openings" | "candidates" | "outreach" | "placements";
export type FieldType = "text" | "number" | "date" | "enum";
export type Agg = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";

export type FilterOp =
  | "contains" | "not_contains" | "is" | "is_not"
  | "gt" | "gte" | "lt" | "lte"
  | "is_empty" | "not_empty";

export interface Filter {
  field: string;
  op: FilterOp;
  value: string;
}

export interface Metric {
  field: string;
  agg: Agg;
}

/** How the comparison is drawn. `auto` reads the shape of the data. */
export type ChartKind = "auto" | "bar" | "column" | "line" | "donut" | "funnel" | "none";

/** A date group has to be bucketed before it means anything — 172 distinct
 *  days is not a trend, twelve months is. */
export type Bucket = "day" | "week" | "month" | "quarter";

export interface ReportSpec {
  dataset: DatasetKey;
  /** Detail columns. Ignored when grouping. */
  columns: string[];
  filters: Filter[];
  groupBy: string | null;
  metrics: Metric[];
  sort: { field: string; dir: "asc" | "desc" } | null;
  /** When grouping on a date, the size of each step. */
  bucket?: Bucket;
  /** Overrides the automatic choice. */
  chart?: ChartKind;
  /** Relative window applied to `dateField`. */
  period: PeriodKey;
  /** Which date the period measures. Defaults to the dataset's own. */
  dateField?: string;
  limit: number;
}

export const PERIODS = [
  { key: "all", label: "All time", days: null },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last 12 months", days: 365 },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "day", label: "By day" },
  { key: "week", label: "By week" },
  { key: "month", label: "By month" },
  { key: "quarter", label: "By quarter" },
];

export const CHARTS: { key: ChartKind; label: string }[] = [
  { key: "auto", label: "Automatic" },
  { key: "column", label: "Columns" },
  { key: "bar", label: "Bars" },
  { key: "line", label: "Trend" },
  { key: "donut", label: "Share" },
  { key: "funnel", label: "Funnel" },
  { key: "none", label: "Table only" },
];

export const OPS: { op: FilterOp; label: string; types: FieldType[] }[] = [
  { op: "is", label: "is", types: ["text", "enum", "number"] },
  { op: "is_not", label: "is not", types: ["text", "enum", "number"] },
  { op: "contains", label: "contains", types: ["text", "enum"] },
  { op: "not_contains", label: "does not contain", types: ["text", "enum"] },
  { op: "gt", label: "is more than", types: ["number", "date"] },
  { op: "gte", label: "is at least", types: ["number", "date"] },
  { op: "lt", label: "is less than", types: ["number", "date"] },
  { op: "lte", label: "is at most", types: ["number", "date"] },
  { op: "is_empty", label: "is empty", types: ["text", "enum", "number", "date"] },
  { op: "not_empty", label: "is not empty", types: ["text", "enum", "number", "date"] },
];

export const AGGS: { agg: Agg; label: string; types: FieldType[] }[] = [
  { agg: "count", label: "Count of", types: ["text", "enum", "number", "date"] },
  { agg: "count_distinct", label: "Distinct", types: ["text", "enum", "number"] },
  { agg: "sum", label: "Sum of", types: ["number"] },
  { agg: "avg", label: "Average", types: ["number"] },
  { agg: "min", label: "Lowest", types: ["number", "date"] },
  { agg: "max", label: "Highest", types: ["number", "date"] },
];

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  /** Shown in the filter picker, so nobody filters on a spelling that returns
   *  nothing. Built from the data, not hardcoded. */
  options?: string[];
}

export type Row = Record<string, string | number | null>;


const F = (key: string, label: string, type: FieldType): Field => ({ key, label, type });

/** What a dataset is, without how it is built — the builder runs in the
 *  browser and must never pull the store in behind it. */
export interface DatasetMeta {
  key: DatasetKey;
  label: string;
  note: string;
  dateField: string;
  fields: Field[];
}

export const DATASETS: DatasetMeta[] = [
  {
    key: "openings",
    label: "Openings",
    note: "One row per role, with everything counted against it.",
    dateField: "assignedAt",
    fields: [
      F("title", "Position", "text"), F("client", "Client", "enum"),
      F("industry", "Industry", "enum"), F("status", "Status", "enum"),
      F("positionStatus", "Position status", "enum"), F("jdStatus", "JD status", "enum"),
      F("priority", "Priority", "enum"), F("locations", "Locations", "text"),
      F("nationality", "Nationality", "text"), F("headcount", "Headcount", "number"),
      F("ta", "TA", "enum"), F("lead", "Lead", "enum"),
      F("salaryMin", "Salary from", "number"), F("salaryMax", "Salary to", "number"),
      F("currency", "Currency", "enum"),
      F("assignedAt", "Assigned", "date"), F("closedAt", "Closed", "date"),
      F("createdAt", "Created", "date"),
      F("daysOpen", "Days open", "number"), F("targetDays", "Target days", "number"),
      F("daysOverTarget", "Days over target", "number"),
      F("posts", "Posts", "number"), F("totalCvs", "Total CVs", "number"),
      F("setsClosed", "Sets closed", "number"), F("hunted", "Headhunted", "number"),
      F("eyeMarked", "Eye-marked", "number"), F("contacted", "Contacted", "number"),
      F("approached", "Approached", "number"),
      F("inPipeline", "In pipeline", "number"),
      F("directorShortlist", "Director shortlist", "number"),
      F("clientShortlist", "Client shortlist", "number"),
      F("interviewed", "Interviewed", "number"), F("placed", "Placed", "number"),
      F("rejected", "Rejected or dropped", "number"),
      F("valueInProgress", "Value in progress", "number"),
      F("valuePlaced", "Value placed", "number"),
      F("valueLost", "Value lost", "number"), F("valueOnHold", "Value on hold", "number"),
      F("l1Date", "L1 date", "date"), F("l1Profiles", "L1 profiles", "number"),
      F("l2Date", "L2 date", "date"), F("l2Profiles", "L2 profiles", "number"),
      F("l3Date", "L3 date", "date"), F("l3Profiles", "L3 profiles", "number"),
      F("l4Date", "L4 date", "date"), F("l4Profiles", "L4 profiles", "number"),
      F("totalLs", "Total Ls", "number"),
      F("set1Date", "Set 1 date", "date"), F("set1Cvs", "Set 1 CVs", "number"),
      F("set2Date", "Set 2 date", "date"), F("set2Cvs", "Set 2 CVs", "number"),
      F("set3Date", "Set 3 date", "date"), F("set3Cvs", "Set 3 CVs", "number"),
      F("set4Date", "Set 4 date", "date"), F("set4Cvs", "Set 4 CVs", "number"),
      F("cvsSent", "Total CVs sent", "number"),
      F("internalShortlist1", "Internal shortlist 1", "number"),
      F("internalShortlist2", "Internal shortlist 2", "number"),
      F("internalShortlist3", "Internal shortlist 3", "number"),
      F("internalShortlist4", "Internal shortlist 4", "number"),
      F("internalShortlistTotal", "Internal shortlist total", "number"),
      F("externalShortlist1", "External shortlist 1", "number"),
      F("externalShortlist2", "External shortlist 2", "number"),
      F("externalShortlist3", "External shortlist 3", "number"),
      F("externalShortlist4", "External shortlist 4", "number"),
      F("externalShortlistTotal", "External shortlist total", "number"),
      F("withdrawn", "Withdrawn / dropped / no answer", "number"),
      F("finalists", "In finals", "number"),
      F("reference", "Reference", "text"),
    ],
  },
  {
    key: "candidates",
    label: "Candidates",
    note: "One row per person on an opening — the same person twice if they are on two.",
    dateField: "createdAt",
    fields: [
      F("candidate", "Candidate", "text"), F("opening", "Opening", "enum"),
      F("client", "Client", "enum"), F("stage", "Stage", "enum"),
      F("channel", "Source", "enum"), F("owner", "Owner", "enum"),
      F("setNumber", "Set", "number"), F("rating", "Rating", "number"),
      F("isAddOn", "Add-on", "enum"),
      F("currentTitle", "Current title", "text"), F("currentEmployer", "Current employer", "enum"),
      F("location", "Location", "enum"), F("nationality", "Nationality", "enum"),
      F("age", "Age", "number"), F("experienceYears", "Years of experience", "number"),
      F("education", "Qualification", "enum"), F("school", "Institution", "enum"),
      F("english", "English /10", "number"), F("noticeDays", "Notice days", "number"),
      F("skills", "Skills", "text"), F("industries", "Industries", "text"),
      F("rejectReason", "Reason out", "text"),
      F("currentSalary", "Current salary", "text"), F("expectedSalary", "Expected salary", "text"),
      F("shortlistedAt", "Shortlisted", "date"), F("createdAt", "Added", "date"),
      F("lastMovedAt", "Last moved", "date"),
    ],
  },
  {
    key: "outreach",
    label: "Headhunting",
    note: "One row per profile in an Excel Table, and what came of it.",
    dateField: "addedAt",
    fields: [
      F("person", "Person", "text"), F("title", "Their title", "text"),
      F("company", "Their company", "enum"), F("opening", "Opening", "enum"),
      F("client", "Client", "enum"), F("outcome", "Outcome", "enum"),
      F("eyeMarked", "Eye-marked", "enum"), F("hasNumber", "Number found", "enum"),
      F("numberFrom", "Number from", "enum"), F("approaches", "Approaches logged", "number"),
      F("addedBy", "Added by", "enum"), F("addedAt", "Added", "date"),
      F("capturedFromLinkedIn", "From the extension", "enum"),
    ],
  },
  {
    // Placements are their own records with their own dates. Counting
    // applications that currently read "Placed", by the month they were
    // shortlisted, answered a different question (audit finding 30).
    key: "placements",
    label: "Placements",
    note: "One row per placement, dated by when it was recorded and when they join.",
    dateField: "placedAt",
    fields: [
      F("candidate", "Candidate", "text"), F("opening", "Opening", "enum"),
      F("client", "Client", "enum"), F("placedBy", "Placed by", "enum"),
      F("channel", "Source", "enum"), F("placedAt", "Placed", "date"),
      F("joinDate", "Joining", "date"), F("fellThrough", "Fell through", "enum"),
    ],
  },
];


export const datasetMeta = (k: DatasetKey) => DATASETS.find((d) => d.key === k) ?? DATASETS[0];
export interface Column {
  key: string;
  label: string;
  type: FieldType;
}

export const DEFAULT_SPEC: ReportSpec = {
  dataset: "openings",
  columns: ["client", "title", "ta", "status", "daysOpen", "totalCvs", "directorShortlist", "placed"],
  filters: [],
  groupBy: null,
  metrics: [],
  sort: null,
  period: "all",
  limit: 500,
};

/** Dates are stored as epoch millis; a report shows them as dates. */
export function cellText(value: string | number | null, type: FieldType): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "date") {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return new Date(n).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: TIMEZONE });
  }
  return String(value);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A Date whose UTC fields read as the Colombo wall clock. Buckets are Colombo
 * days, weeks and months: on the UTC server, everything done before 05:30
 * Colombo time fell into the previous day's bucket (2 Oct).
 */
function colomboClock(ms: number): Date {
  return new Date(ms + COLOMBO_OFFSET_MS);
}

/** Monday of the Colombo week containing `ms`, on the Colombo clock. */
function colomboMonday(ms: number): Date {
  const d = colomboClock(ms);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
}

/** A label a person reads, from a moment. Ordering is handled separately, by
 *  the sequence the engine hands back — never by sorting these strings. */
export function bucketLabel(ms: number, bucket: Bucket): string {
  const d = colomboClock(ms);
  const y = d.getUTCFullYear();
  switch (bucket) {
    case "day": return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    case "week": {
      // Monday of that week — a week label that moves is worse than no label.
      const m = colomboMonday(ms);
      return `w/c ${m.getUTCDate()} ${MONTHS[m.getUTCMonth()]}`;
    }
    case "quarter": return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`;
    default: return `${MONTHS[d.getUTCMonth()]} ${y}`;
  }
}

/** The sortable form, used only to order the buckets. */
export function bucketKey(ms: number, bucket: Bucket): string {
  const d = colomboClock(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  switch (bucket) {
    case "day": return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    case "week": {
      const m = colomboMonday(ms);
      return `${m.getUTCFullYear()}-${p(m.getUTCMonth() + 1)}-${p(m.getUTCDate())}`;
    }
    case "quarter": return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    default: return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`;
  }
}

/**
 * A cell a spreadsheet will not run.
 *
 * Quoting does not stop Excel treating "=HYPERLINK(...)" or "+1+1" as a
 * formula, and CSV cells here carry text people and CVs typed (audit finding
 * 35). A leading apostrophe makes it plain text; Excel hides the apostrophe.
 */
function safeCell(v: unknown): string {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(safeCell).join(",")).join("\r\n");
}


// ─── presets ─────────────────────────────────────────────────────────────────

/**
 * Starting points, not fixed views. The Master Sheet is one of these rather
 * than a hardcoded page, so the two workbooks it replaces are still one click
 * away and are editable like anything else.
 */
export interface Preset {
  key: string;
  label: string;
  note: string;
  spec: ReportSpec;
}

const base = (over: Partial<ReportSpec>): ReportSpec => ({ ...DEFAULT_SPEC, ...over });

export const PRESETS: Preset[] = [
  {
    key: "master",
    label: "Master Sheet",
    note: "The old workbook, calculated from live system activity instead of typed twice.",
    spec: base({
      dataset: "openings",
      columns: [
        "client", "title", "positionStatus", "ta",
        "eyeMarked", "contacted", "hunted",
        "valueInProgress", "valuePlaced", "valueLost", "valueOnHold",
        "assignedAt", "closedAt",
        "l1Date", "l1Profiles", "l2Date", "l2Profiles",
        "l3Date", "l3Profiles", "l4Date", "l4Profiles", "totalLs",
        "set1Date", "set1Cvs", "set2Date", "set2Cvs",
        "set3Date", "set3Cvs", "set4Date", "set4Cvs", "cvsSent",
        "internalShortlist1", "internalShortlist2", "internalShortlist3", "internalShortlist4", "internalShortlistTotal",
        "externalShortlist1", "externalShortlist2", "externalShortlist3", "externalShortlist4", "externalShortlistTotal",
        "interviewed", "withdrawn", "finalists",
      ],
      sort: { field: "client", dir: "asc" },
    }),
  },
  {
    key: "by-client",
    label: "Work by client",
    note: "How much is running at each client, and what it is worth.",
    spec: base({
      dataset: "openings",
      groupBy: "client",
      metrics: [
        { field: "client", agg: "count" },
        { field: "totalCvs", agg: "sum" },
        { field: "placed", agg: "sum" },
        { field: "valueInProgress", agg: "sum" },
      ],
      sort: { field: "sum:valueInProgress", dir: "desc" },
    }),
  },
  {
    key: "by-ta",
    label: "Load by TA",
    note: "Roles each person carries, and what has come out of them.",
    spec: base({
      dataset: "openings",
      groupBy: "ta",
      metrics: [
        { field: "ta", agg: "count" },
        { field: "totalCvs", agg: "sum" },
        { field: "directorShortlist", agg: "sum" },
        { field: "placed", agg: "sum" },
        { field: "daysOpen", agg: "avg" },
      ],
      filters: [{ field: "status", op: "is", value: "open" }],
      sort: { field: "count:ta", dir: "desc" },
    }),
  },
  {
    key: "over-target",
    label: "Past their target",
    note: "Open roles that have run past the days their priority allows.",
    spec: base({
      dataset: "openings",
      columns: ["client", "title", "ta", "priority", "daysOpen", "targetDays", "daysOverTarget", "totalCvs"],
      filters: [
        { field: "status", op: "is", value: "open" },
        { field: "daysOverTarget", op: "gt", value: "0" },
      ],
      sort: { field: "daysOverTarget", dir: "desc" },
    }),
  },
  {
    key: "over-time",
    label: "CVs month by month",
    note: "Applications added each month — a person on two openings counts twice.",
    spec: base({
      dataset: "candidates",
      groupBy: "createdAt",
      bucket: "month",
      metrics: [{ field: "createdAt", agg: "count" }],
    }),
  },
  {
    key: "placements-over-time",
    label: "Placements over time",
    note: "Placements recorded each month.",
    spec: base({
      dataset: "placements",
      groupBy: "placedAt",
      bucket: "month",
      metrics: [{ field: "placedAt", agg: "count" }],
    }),
  },
  {
    key: "drop-off",
    label: "Where candidates stop",
    note: "How many people sit at each stage across the desk.",
    spec: base({
      dataset: "candidates",
      groupBy: "stage",
      metrics: [{ field: "stage", agg: "count" }],
      sort: { field: "count:stage", dir: "desc" },
    }),
  },
  {
    key: "reasons-out",
    label: "Why candidates drop",
    note: "The reasons recorded when someone leaves the pipeline.",
    spec: base({
      dataset: "candidates",
      groupBy: "rejectReason",
      metrics: [{ field: "rejectReason", agg: "count" }],
      filters: [{ field: "rejectReason", op: "not_empty", value: "" }],
      sort: { field: "count:rejectReason", dir: "desc" },
    }),
  },
  {
    key: "outreach",
    label: "Headhunting outcomes",
    note: "What happened to the profiles the desk approached.",
    spec: base({
      dataset: "outreach",
      groupBy: "outcome",
      metrics: [
        { field: "outcome", agg: "count" },
        { field: "approaches", agg: "sum" },
      ],
      sort: { field: "count:outcome", dir: "desc" },
    }),
  },
  {
    key: "salary",
    label: "Salary against notice",
    note: "What people are asking, and how quickly they could start.",
    spec: base({
      dataset: "candidates",
      columns: ["candidate", "opening", "currentSalary", "expectedSalary", "noticeDays", "experienceYears", "stage"],
      sort: { field: "noticeDays", dir: "asc" },
    }),
  },
];

export const presetFor = (k: string) => PRESETS.find((p) => p.key === k);


// ─── reading a spec from outside ─────────────────────────────────────────────

const FILTER_OPS: FilterOp[] = ["contains", "not_contains", "is", "is_not", "gt", "gte", "lt", "lte", "is_empty", "not_empty"];
const AGG_KEYS: Agg[] = ["count", "count_distinct", "sum", "avg", "min", "max"];

/**
 * A spec from a URL or a saved report, made safe to run.
 *
 * It arrived as JSON anybody could edit, and a null where a list belonged
 * crashed the page and its export (audit finding 34). Every part is checked
 * against the vocabulary; anything that is not one of ours is dropped, never
 * guessed at.
 */
export function sanitizeSpec(input: unknown, fallback: ReportSpec): ReportSpec {
  if (!input || typeof input !== "object") return fallback;
  const x = input as Record<string, unknown>;
  const ds = DATASETS.find((d) => d.key === x.dataset) ?? DATASETS.find((d) => d.key === fallback.dataset)!;
  const known = new Set(ds.fields.map((f) => f.key));
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  const columns = Array.isArray(x.columns) ? x.columns.filter((c): c is string => typeof c === "string" && known.has(c)) : [];
  const filters = Array.isArray(x.filters)
    ? x.filters
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f) => ({ field: str(f.field), op: str(f.op) as FilterOp, value: str(f.value) }))
        .filter((f) => known.has(f.field) && FILTER_OPS.includes(f.op))
    : [];
  const metrics = Array.isArray(x.metrics)
    ? x.metrics
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => ({ field: str(m.field), agg: str(m.agg) as Agg }))
        .filter((m) => known.has(m.field) && AGG_KEYS.includes(m.agg))
    : [];
  const groupBy = typeof x.groupBy === "string" && known.has(x.groupBy) ? x.groupBy : null;
  const sortIn = x.sort as Record<string, unknown> | null | undefined;
  const sort =
    sortIn && typeof sortIn === "object" && typeof sortIn.field === "string"
      ? { field: sortIn.field, dir: sortIn.dir === "asc" ? ("asc" as const) : ("desc" as const) }
      : null;
  const period = PERIODS.some((p) => p.key === x.period) ? (x.period as PeriodKey) : "all";
  const limit = Math.min(10_000, Math.max(1, Math.round(Number(x.limit)) || fallback.limit));
  const bucket = (["day", "week", "month", "quarter"] as const).find((b) => b === x.bucket);
  const chart = (["auto", "bar", "column", "line", "donut", "funnel", "none"] as const).find((c) => c === x.chart);
  const dateField = typeof x.dateField === "string" && known.has(x.dateField) ? x.dateField : undefined;

  return { dataset: ds.key, columns, filters, groupBy, metrics, sort, period, limit, bucket, chart, dateField };
}
