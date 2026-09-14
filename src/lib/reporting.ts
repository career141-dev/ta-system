/**
 * The report engine — the half that reads records.
 *
 * One rule holds the whole thing together: **a report is a spec, and the spec
 * is evaluated against the records.** Nothing that produces a number is allowed
 * to be creative. When a TA asks for a report in English the model's only job
 * is to turn the sentence into a `ReportSpec` — which dataset, which columns,
 * which filters, what to group by. The figures are then counted here, in
 * ordinary code, from the same store every screen reads. A model asked for a
 * total will happily invent a plausible one; a model asked for a filter cannot.
 *
 * The vocabulary lives in `reportSpec.ts` so the builder can import it without
 * dragging the store into the browser.
 */

import { repo, setsForOpening, stageCounts } from "@/data/store";
import { PRIORITY_TARGET, STAGE_LABEL, type Stage } from "@/data/types";
import {
  AGGS, PERIODS, bucketKey, bucketLabel, cellText, datasetMeta, toCsv,
  type Agg, type Column, type DatasetKey, type FieldType,
  type Filter, type ReportSpec, type Row,
} from "./reportSpec";
import type { Stage as PipelineStage } from "@/data/types";

export * from "./reportSpec";

// ─── the datasets ────────────────────────────────────────────────────────────

const STAGES: Stage[] = [
  "new_cv", "matched", "follow_up",
  "director_review", "director_shortlist", "client_shortlist",
  "interview", "offer", "placed", "rejected", "dropped_out",
];

function openingRows(): Row[] {
  const clients = repo.clients();
  const users = repo.users();
  const name = (id: string) => users.find((u) => u.id === id)?.name ?? null;

  return repo.openings().map((o) => {
    const c = stageCounts(o.id);
    const sets = setsForOpening(o.id);
    const vault = repo.linkVault(o.id);
    const apps = repo.applications(o.id);
    const target = PRIORITY_TARGET[o.priorityTier].days;
    const days = o.assignedAt ? Math.floor((Date.now() - o.assignedAt) / 86_400_000) : null;

    return {
      id: o.id,
      title: o.title,
      client: clients.find((x) => x.id === o.clientId)?.name ?? null,
      industry: clients.find((x) => x.id === o.clientId)?.industry ?? null,
      status: o.status,
      positionStatus: o.positionStatus,
      jdStatus: o.jdStatus,
      priority: o.priorityTier,
      locations: o.locations.join(", ") || null,
      nationality: o.targetNationalities.join(", ") || null,
      headcount: o.headcount,
      ta: o.assignedTaIds.map(name).filter(Boolean).join(", ") || null,
      lead: name(o.taLeadId),
      salaryMin: o.salaryMin,
      salaryMax: o.salaryMax,
      currency: o.salaryCurrency,
      assignedAt: o.assignedAt,
      closedAt: o.closedAt,
      createdAt: o.createdAt,
      daysOpen: days,
      targetDays: target,
      daysOverTarget: days === null ? null : days - target,
      posts: repo.jobPosts(o.id).length,
      // Every CV on the opening. Summing set members left out everyone not yet
      // in a set — which is every new applicant (audit finding 29).
      totalCvs: apps.filter((a) => a.sourcingChannel !== "SCOOP").length,
      setsClosed: sets.filter((s) => s.status === "closed").length,
      hunted: apps.filter((a) => a.sourcingChannel === "HH").length,
      eyeMarked: vault.filter((v) => v.isEyeMarked).length,
      approached: vault.filter((v) => v.outcome !== "no_contact").length,
      inPipeline: apps.length,
      directorShortlist: c.director_shortlist ?? 0,
      clientShortlist: c.client_shortlist ?? 0,
      interviewed: c.interview ?? 0,
      placed: c.placed ?? 0,
      rejected: (c.rejected ?? 0) + (c.dropped_out ?? 0),
      valueInProgress: o.valueOnProgressing,
      valuePlaced: o.valueOfPlacement,
      reference: o.positionCode,
    };
  });
}

function candidateRows(): Row[] {
  const users = repo.users();
  const clients = repo.clients();
  const openings = repo.openings();
  const name = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);

  return repo.openings().flatMap((o) =>
    repo.applications(o.id).flatMap((a) => {
      const c = repo.candidate(a.candidateId);
      if (!c) return [];
      const op = openings.find((x) => x.id === a.openingId);
      return [{
        candidate: c.fullName,
        opening: op?.title ?? null,
        client: clients.find((x) => x.id === op?.clientId)?.name ?? null,
        stage: STAGE_LABEL[a.stage],
        stageKey: a.stage,
        channel: a.sourcingChannel,
        owner: name(a.ownerTaId),
        setNumber: a.setNumber,
        rating: a.rating,
        isAddOn: a.isAddOn ? "Yes" : "No",
        currentTitle: c.currentTitle,
        currentEmployer: c.currentEmployer,
        location: c.location,
        nationality: c.nationality,
        age: c.age,
        experienceYears: c.totalExperienceYears,
        education: c.educationDegree,
        school: c.educationInstitution,
        english: c.englishLevel,
        noticeDays: c.noticePeriodDays,
        skills: c.skills.join(", ") || null,
        industries: c.industries.join(", ") || null,
        rejectReason: a.rejectReason ?? a.droppedOutReason ?? null,
        currentSalary: c.currentSalary,
        expectedSalary: c.expectedSalary,
        shortlistedAt: a.shortlistedAt,
        createdAt: a.createdAt,
        lastMovedAt: a.lastStageChangedAt,
      }];
    }),
  );
}

function outreachRows(): Row[] {
  const users = repo.users();
  const clients = repo.clients();
  const name = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);

  return repo.openings().flatMap((o) =>
    repo.linkVault(o.id).map((l) => ({
      person: l.name,
      title: l.title,
      company: l.company,
      opening: o.title,
      client: clients.find((x) => x.id === o.clientId)?.name ?? null,
      outcome: l.outcome,
      eyeMarked: l.isEyeMarked ? "Yes" : "No",
      hasNumber: l.phoneNumber ? "Yes" : "No",
      numberFrom: l.phoneSource,
      approaches: l.conversationLog.length,
      addedBy: name(l.addedBy),
      addedAt: l.createdAt,
      capturedFromLinkedIn: l.capture ? "Yes" : "No",
    })),
  );
}


function placementRows(): Row[] {
  const users = repo.users();
  const clients = repo.clients();
  return repo.placements().map((p) => {
    const o = repo.opening(p.openingId);
    return {
      candidate: repo.candidate(p.candidateId)?.fullName ?? null,
      opening: o?.title ?? null,
      client: clients.find((c) => c.id === p.clientId)?.name ?? null,
      placedBy: users.find((u) => u.id === p.placedBy)?.name ?? null,
      channel: p.sourcingChannel,
      placedAt: p.createdAt,
      joinDate: p.joinDate,
      fellThrough: p.fellThroughAt ? "Yes" : "No",
    };
  });
}

const ROWS: Record<DatasetKey, () => Row[]> = {
  openings: openingRows,
  candidates: candidateRows,
  outreach: outreachRows,
  placements: placementRows,
};

export interface Dataset extends ReturnType<typeof datasetMeta> {
  rows: () => Row[];
}

export const datasetFor = (k: DatasetKey): Dataset => ({ ...datasetMeta(k), rows: ROWS[k] });

/** Enum options read off the data, so the picker only offers what exists. */
export function optionsFor(dataset: DatasetKey, fieldKey: string): string[] {
  const rows = ROWS[dataset]();
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[fieldKey];
    if (v === null || v === undefined || v === "") continue;
    // A cell holding "Nuha, Sanduni" is two values, not one.
    for (const part of String(v).split(",")) {
      const t = part.trim();
      if (t) seen.add(t);
    }
  }
  return [...seen].sort().slice(0, 200);
}

function passes(row: Row, f: Filter, type: FieldType): boolean {
  const raw = row[f.field];
  const empty = raw === null || raw === undefined || raw === "";
  if (f.op === "is_empty") return empty;
  if (f.op === "not_empty") return !empty;
  if (empty) return false;

  if (type === "number" || type === "date") {
    const n = Number(raw);
    const v = type === "date" ? Date.parse(f.value) : Number(f.value);
    // An unreadable filter value matches nothing. It used to match everything,
    // so a typo in "salary over" returned the whole table (audit finding 34).
    if (!Number.isFinite(n) || !Number.isFinite(v)) return false;
    switch (f.op) {
      case "is": return n === v;
      case "is_not": return n !== v;
      case "gt": return n > v;
      case "gte": return n >= v;
      case "lt": return n < v;
      case "lte": return n <= v;
      default: return true;
    }
  }

  const hay = String(raw).toLowerCase();
  const needle = f.value.toLowerCase().trim();
  switch (f.op) {
    // "is" on a multi-value cell means it is one of them — a TA filter for
    // Nuha must match a role she shares with Sanduni.
    case "is": return hay.split(",").map((x) => x.trim()).includes(needle);
    case "is_not": return !hay.split(",").map((x) => x.trim()).includes(needle);
    case "contains": return hay.includes(needle);
    case "not_contains": return !hay.includes(needle);
    default: return true;
  }
}

function aggregate(values: (string | number | null)[], agg: Agg): number | string | null {
  // Blanks are left out before converting: Number(null) is 0, and averaging
  // unknown notice periods as zero days pulled every average down (audit
  // finding 31).
  const nums = values
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  switch (agg) {
    case "count": return values.filter((v) => v !== null && v !== undefined && v !== "").length;
    case "count_distinct": return new Set(values.filter((v) => v !== null && v !== "")).size;
    case "sum": return nums.reduce((a, b) => a + b, 0);
    case "avg": return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
    case "min": return nums.length ? Math.min(...nums) : null;
    case "max": return nums.length ? Math.max(...nums) : null;
  }
}

export interface ReportResult {
  columns: Column[];
  rows: Row[];
  /** Rows before grouping and the limit — what the filters actually matched. */
  matched: number;
  truncated: boolean;
  /**
   * The groups in their own order rather than the table's: months run
   * chronologically and stages run down the pipeline, whatever the reader has
   * sorted the table by. A trend sorted by size is not a trend.
   */
  order?: string[];
  /** True when the groups are a sequence — the charts use it to decide whether
   *  a line or a funnel is honest. */
  sequence?: "time" | "stage" | null;
}

export function runReport(spec: ReportSpec): ReportResult {
  const ds = datasetFor(spec.dataset);
  const typeOf = (k: string) => ds.fields.find((f) => f.key === k)?.type ?? "text";
  const labelOf = (k: string) => ds.fields.find((f) => f.key === k)?.label ?? k;

  let rows = ds.rows();

  // Period first — it is the filter people forget they left on.
  const days = PERIODS.find((p) => p.key === spec.period)?.days ?? null;
  if (days) {
    const field = spec.dateField ?? ds.dateField;
    const cutoff = Date.now() - days * 86_400_000;
    rows = rows.filter((r) => {
      const v = Number(r[field]);
      return Number.isFinite(v) && v >= cutoff;
    });
  }

  for (const f of spec.filters) {
    if (!f.field) continue;
    rows = rows.filter((r) => passes(r, f, typeOf(f.field)));
  }
  const matched = rows.length;

  let columns: Column[];
  let out: Row[];

  let order: string[] | undefined;
  let sequence: "time" | "stage" | null = null;

  if (spec.groupBy) {
    const groupType = typeOf(spec.groupBy);
    const bucket = spec.bucket ?? "month";
    const groups = new Map<string, Row[]>();
    // Dates are ordered by their sortable form, not their label.
    const sortKeys = new Map<string, string>();

    for (const r of rows) {
      const raw = r[spec.groupBy];
      let keys: string[];

      if (groupType === "date") {
        // 172 distinct days is not a trend; twelve months is.
        // A missing date is "No date", not 1 January 1970 (audit finding 32).
        const ms = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
        if (!Number.isFinite(ms) || ms <= 0) keys = ["No date"];
        else {
          const label = bucketLabel(ms, bucket);
          sortKeys.set(label, bucketKey(ms, bucket));
          keys = [label];
        }
      } else {
        // A row whose cell holds two names belongs to both groups — otherwise a
        // shared opening lands under "Nuha, Sanduni" and neither TA's total is
        // right.
        keys = raw === null || raw === undefined || raw === ""
          ? ["—"]
          : String(raw).split(",").map((x) => x.trim()).filter(Boolean);
      }

      for (const k of keys) {
        const list = groups.get(k) ?? [];
        list.push(r);
        groups.set(k, list);
      }
    }

    if (groupType === "date") {
      sequence = "time";
      order = [...groups.keys()].sort((a, b) =>
        (sortKeys.get(a) ?? a).localeCompare(sortKeys.get(b) ?? b),
      );

      // A month with nothing in it is a fact about the desk, and dropping it
      // squeezes the gap out of the axis — so a quiet summer reads as steady
      // work. Empty steps are filled in between the first and the last.
      const stamps = rows
        .map((r) => r[spec.groupBy!])
        .filter((v) => v !== null && v !== undefined && v !== "")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      if (stamps.length > 1) {
        const filled: string[] = [];
        const cursor = new Date(Math.min(...stamps));
        const end = new Date(Math.max(...stamps));
        if (bucket === "month" || bucket === "quarter") cursor.setDate(1);
        const step = () => {
          if (bucket === "day") cursor.setDate(cursor.getDate() + 1);
          else if (bucket === "week") cursor.setDate(cursor.getDate() + 7);
          else if (bucket === "quarter") cursor.setMonth(cursor.getMonth() + 3);
          else cursor.setMonth(cursor.getMonth() + 1);
        };
        // Bounded so a day-bucketed decade cannot run away with the page.
        for (let guard = 0; cursor <= end && guard < 400; guard++, step()) {
          const lab = bucketLabel(cursor.getTime(), bucket);
          if (!filled.includes(lab)) filled.push(lab);
          if (!groups.has(lab)) groups.set(lab, []);
        }
        if (filled.length && filled.length < 400) order = filled;
      }
    } else if (spec.groupBy === "stage" || spec.groupBy === "stageKey") {
      sequence = "stage";
      const rank = new Map(STAGES.map((st, i) => [STAGE_LABEL[st as PipelineStage], i]));
      order = [...groups.keys()].sort(
        (a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99),
      );
    }

    const metrics = spec.metrics.length ? spec.metrics : [{ field: spec.groupBy, agg: "count" as Agg }];
    columns = [
      { key: spec.groupBy, label: labelOf(spec.groupBy), type: typeOf(spec.groupBy) },
      ...metrics.map((m) => ({
        key: `${m.agg}:${m.field}`,
        label:
          m.agg === "count" && m.field === spec.groupBy
            ? "Rows"
            : `${AGGS.find((a) => a.agg === m.agg)?.label ?? m.agg} ${labelOf(m.field).toLowerCase()}`,
        type: "number" as FieldType,
      })),
    ];

    out = [...groups.entries()].map(([k, list]) => {
      const row: Row = { [spec.groupBy!]: k };
      for (const m of metrics) {
        row[`${m.agg}:${m.field}`] =
          m.agg === "count" && m.field === spec.groupBy
            ? list.length
            : aggregate(list.map((r) => r[m.field]), m.agg);
      }
      return row;
    });
  } else {
    const cols: string[] = spec.columns.length ? spec.columns : ds.fields.slice(0, 6).map((f) => f.key);
    columns = cols.map((k) => ({ key: k, label: labelOf(k), type: typeOf(k) }));
    out = rows.map((r) => Object.fromEntries(cols.map((k) => [k, r[k] ?? null])) as Row);
  }

  if (spec.sort) {
    const { field, dir } = spec.sort;
    const sign = dir === "asc" ? 1 : -1;
    out.sort((a, b) => {
      const x = a[field];
      const y = b[field];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const nx = Number(x);
      const ny = Number(y);
      if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * sign;
      return String(x).localeCompare(String(y)) * sign;
    });
  }

  const truncated = out.length > spec.limit;
  return { columns, rows: out.slice(0, spec.limit), matched, truncated, order, sequence };
}


export function reportCsv(spec: ReportSpec): string {
  const { columns, rows } = runReport({ ...spec, limit: 100_000 });
  return toCsv([
    columns.map((c) => c.label),
    ...rows.map((r) => columns.map((c) => cellText(r[c.key], c.type))),
  ]);
}
