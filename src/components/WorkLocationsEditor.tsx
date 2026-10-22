"use client";

import { useState } from "react";
import type { WorkLocation } from "@/lib/workLocations";
import { inputClass } from "./form";

export function WorkLocationsEditor({ initial }: { initial?: WorkLocation[] }) {
  const [rows, setRows] = useState<WorkLocation[]>(initial ?? [{ id: "location_1", name: "", vacancies: 1 }]);
  const patch = (id: string, change: Partial<WorkLocation>) => setRows(rows.map(r => r.id === id ? { ...r, ...change } : r));
  return <fieldset className="my-5 space-y-3">
    <legend className="text-[13.5px] font-semibold">Work locations &amp; vacancies</legend>
    <p className="text-[12px] text-ink-soft">Add each city and the number of people needed there. Each location has its own L-sheets and EOD email.</p>
    <input type="hidden" name="workLocations" value={JSON.stringify(rows)} />
    {rows.map(row => <div key={row.id} className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 text-[12px]">City / location
        <input aria-label="City / location" value={row.name} disabled={row.archived} required={!row.archived} maxLength={100} onChange={e => patch(row.id, { name: e.target.value })} className={inputClass} />
      </label>
      <label className="w-24 text-[12px]">Vacancies
        <input aria-label="Vacancies" type="number" min={1} max={10000} step={1} required value={row.vacancies} disabled={row.archived} onChange={e => patch(row.id, { vacancies: Number(e.target.value) })} className={inputClass} />
      </label>
      <button type="button" className="px-2 py-3 text-[12px] text-brand" onClick={() => initial?.some(l => l.id === row.id) ? patch(row.id, { archived: !row.archived }) : setRows(rows.filter(l => l.id !== row.id))}>{initial?.some(l => l.id === row.id) ? row.archived ? "Restore" : "Archive" : "Remove"}</button>
    </div>)}
    <div className="flex flex-wrap justify-between gap-3 text-[12px]">
      <button type="button" className="font-medium text-brand" onClick={() => setRows([...rows, { id: `location_${crypto.randomUUID()}`, name: "", vacancies: 1 }])}>+ Add location</button>
      <span>Total vacancies: {rows.filter(r => !r.archived).reduce((sum, r) => sum + (r.vacancies || 0), 0)}</span>
    </div>
  </fieldset>;
}
