import Link from "next/link";
import { updateMasterSheetOpening } from "@/app/actions";
import { colomboDateValue } from "@/lib/calendar";
import { cellText, type Column, type ReportSpec, type Row } from "@/lib/reportSpec";
import { MasterSheetViewport } from "./MasterSheetViewport";

const EDITABLE = new Set([
  "positionStatus",
  "assignedAt",
  "closedAt",
  "valueInProgress",
  "valuePlaced",
  "valueLost",
]);

const GROUP: Record<string, string> = {
  client: "Opening", title: "Opening", positionStatus: "Opening", ta: "Opening",
  eyeMarked: "Sourcing", contacted: "Sourcing", hunted: "Sourcing",
  valueInProgress: "Commercial value", valuePlaced: "Commercial value", valueLost: "Commercial value", valueOnHold: "Commercial value",
  assignedAt: "Dates", closedAt: "Dates",
  l1Date: "Search levels", l1Profiles: "Search levels", l2Date: "Search levels", l2Profiles: "Search levels",
  l3Date: "Search levels", l3Profiles: "Search levels", l4Date: "Search levels", l4Profiles: "Search levels", totalLs: "Search levels",
  set1Date: "Candidate sets", set1Cvs: "Candidate sets", set2Date: "Candidate sets", set2Cvs: "Candidate sets",
  set3Date: "Candidate sets", set3Cvs: "Candidate sets", set4Date: "Candidate sets", set4Cvs: "Candidate sets", cvsSent: "Candidate sets",
  internalShortlist1: "Internal shortlist", internalShortlist2: "Internal shortlist", internalShortlist3: "Internal shortlist", internalShortlist4: "Internal shortlist", internalShortlistTotal: "Internal shortlist",
  externalShortlist1: "Client shortlist", externalShortlist2: "Client shortlist", externalShortlist3: "Client shortlist", externalShortlist4: "Client shortlist", externalShortlistTotal: "Client shortlist",
  interviewed: "Outcome", withdrawn: "Outcome", finalists: "Outcome", placed: "Outcome",
};

function sourceHref(openingId: string, key: string, taId?: string): string {
  if (key === "eyeMarked" || key === "contacted" || key === "hunted" || /^l[1-4](Date|Profiles)?$/.test(key) || key === "totalLs") {
    return `/openings/${openingId}/hh/links${taId ? `?by=${encodeURIComponent(taId)}` : ""}`;
  }
  if (/^set[1-4](Date|Cvs)?$/.test(key) || /^internalShortlist[1-4]$/.test(key) || key === "cvsSent" || key === "internalShortlistTotal") {
    return `/openings/${openingId}/pipeline/director_review`;
  }
  if (/^externalShortlist[1-4]$/.test(key) || key === "externalShortlistTotal") return `/openings/${openingId}/pipeline/client_shortlist`;
  if (key === "withdrawn") return `/openings/${openingId}/pipeline/dropped_out`;
  if (key === "interviewed" || key === "finalists" || key === "placed") {
    return `/openings/${openingId}/pipeline/interview`;
  }
  return `/openings/${openingId}`;
}

function groups(columns: Column[]): { label: string; span: number }[] {
  const out: { label: string; span: number }[] = [];
  for (const column of columns) {
    const label = GROUP[column.key] ?? "Opening";
    const last = out[out.length - 1];
    if (last?.label === label) last.span++;
    else out.push({ label, span: 1 });
  }
  return out;
}

function stickyCell(key: string, header = false): string {
  const layer = header ? "z-30" : "z-10";
  if (key === "client") return `sticky left-0 ${layer} min-w-[150px] max-w-[150px]`;
  if (key === "title") return `sticky left-[150px] ${layer} min-w-[220px] max-w-[220px]`;
  return "min-w-[118px]";
}

function EditableCell({ column, row, formId }: { column: Column; row: Row; formId: string }) {
  const base = "h-8 w-full min-w-[105px] rounded border border-amber-300 bg-amber-50 px-2 text-[12px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";
  if (column.key === "positionStatus") {
    return (
      <select form={formId} name="positionStatus" defaultValue={String(row[column.key] ?? "active")} className={base}>
        <option value="active">Active</option>
        <option value="hold">On hold</option>
        <option value="lost">Lost</option>
        <option value="filled">Filled</option>
      </select>
    );
  }
  if (column.key === "assignedAt" || column.key === "closedAt") {
    const value = row[column.key];
    return (
      <input
        form={formId}
        name={column.key}
        type="date"
        defaultValue={colomboDateValue(typeof value === "number" ? value : null)}
        className={base}
      />
    );
  }
  const name = column.key === "valueInProgress"
    ? "valueOnProgressing"
    : column.key === "valuePlaced"
      ? "valueOfPlacement"
      : "valueLost";
  const value = row[column.key];
  return (
    <input
      form={formId}
      name={name}
      type="number"
      min="0"
      step="any"
      defaultValue={typeof value === "number" ? value : ""}
      className={base}
      aria-label={column.label}
    />
  );
}

export function MasterSheetTable({
  columns,
  rows,
  spec,
  sortHref,
  canEditById,
  personal,
}: {
  columns: Column[];
  rows: Row[];
  spec: ReportSpec;
  sortHref: (key: string) => string;
  canEditById: Record<string, boolean>;
  personal: boolean;
}) {
  const sectionGroups = groups(columns);
  const editableSheet = Object.values(canEditById).some(Boolean);
  return (
    <>
      {editableSheet && rows.map((row) => {
        const openingId = String(row.id ?? "");
        const rowKey = String(row.rowKey ?? openingId);
        return (
          <form key={rowKey} id={`master-sheet-${rowKey}`} action={updateMasterSheetOpening}>
            <input type="hidden" name="openingId" value={openingId} />
          </form>
        );
      })}

      <MasterSheetViewport editable={editableSheet} personal={personal}>
        <div className="max-h-[72vh] overflow-auto rounded-xl border border-rule bg-surface">
          <table className="min-w-max border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-20">
            <tr>
              {sectionGroups.map((group) => (
                <th
                  key={group.label}
                  colSpan={group.span}
                  className="border-b border-r border-rule bg-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-white"
                >
                  {group.label}
                </th>
              ))}
              {editableSheet && (
                <th rowSpan={2} className="sticky right-0 z-40 min-w-[250px] border-b border-l border-rule bg-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                  Save change
                </th>
              )}
            </tr>
            <tr>
              {columns.map((column) => {
                const active = spec.sort?.field === column.key;
                return (
                  <th
                    key={column.key}
                    className={`${stickyCell(column.key, true)} border-b border-r border-rule bg-slate-100 px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-slate-700`}
                  >
                    <Link href={sortHref(column.key)} className="flex items-center justify-between gap-1 hover:text-brand">
                      <span>{column.label}</span>
                      <span aria-hidden="true">{active ? (spec.sort?.dir === "asc" ? "↑" : "↓") : "↕"}</span>
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const openingId = String(row.id ?? "");
              const rowKey = String(row.rowKey ?? openingId);
              const formId = `master-sheet-${rowKey}`;
              const canEdit = Boolean(canEditById[openingId]);
              return (
                <tr key={rowKey || index} className="group hover:bg-blue-50/40">
                  {columns.map((column) => {
                    const editable = canEdit && EDITABLE.has(column.key);
                    const sourceField = EDITABLE.has(column.key);
                    const sticky = column.key === "client" || column.key === "title";
                    return (
                      <td
                        key={column.key}
                        className={`${stickyCell(column.key)} border-b border-r border-rule px-2 py-1.5 text-[12px] ${
                          sticky ? "bg-white group-hover:bg-blue-50" : editable ? "bg-amber-50/40" : "bg-slate-50/55"
                        }`}
                        title={editable
                          ? "Editable source field"
                          : sourceField
                            ? "Shared job field; editing any TA row updates the same job"
                            : "Calculated from the live workflow; click to open its source"}
                      >
                        {editable ? (
                          <EditableCell column={column} row={row} formId={formId} />
                        ) : (
                          <Link href={sourceHref(openingId, column.key, typeof row.taId === "string" ? row.taId : undefined)} className="block min-h-8 min-w-[96px] whitespace-nowrap px-1 py-1.5 text-ink hover:text-brand hover:underline">
                            {cellText(row[column.key], column.type) || "—"}
                          </Link>
                        )}
                      </td>
                    );
                  })}
                  {editableSheet && <td className="sticky right-0 z-10 border-b border-l border-rule bg-white px-2 py-1.5 group-hover:bg-blue-50">
                    {canEdit ? (
                      <div className="flex items-center gap-2">
                        <input
                          form={formId}
                          name="reason"
                          required
                          minLength={3}
                          maxLength={500}
                          placeholder="Reason for change"
                          aria-label="Reason for change"
                          className="h-8 min-w-[150px] flex-1 rounded border border-rule-strong bg-white px-2 text-[12px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                        />
                        <button form={formId} type="submit" className="h-8 rounded bg-brand px-3 text-[11.5px] font-semibold text-white hover:opacity-90">
                          Save
                        </button>
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-ink-faint">Read only</span>
                    )}
                  </td>}
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
      </MasterSheetViewport>
    </>
  );
}
