import type { WorkLocation } from "@/lib/workLocations";

export function WorkLocationTabs({ locations, selected, basePath, params = {}, sent = [], unassigned = true, paramKey = "location" }: {
  locations?: WorkLocation[]; selected?: string; basePath: string; params?: Record<string, string>; sent?: string[]; unassigned?: boolean; paramKey?: string;
}) {
  if (!locations?.length) return null;
  return <nav aria-label="Work location" className="my-5 flex flex-wrap gap-2">
    {[...locations.map(l => ({ id: l.id, label: `${l.name} · ${l.vacancies} ${l.vacancies === 1 ? "vacancy" : "vacancies"}${l.archived ? " · archived" : ""}` })),
      ...(unassigned ? [{ id: "", label: "Location not assigned" }] : [])].map(l => <a key={l.id} href={`${basePath}?${new URLSearchParams({ ...params, [paramKey]: l.id || "unassigned" })}`} aria-current={selected === l.id ? "page" : undefined}
        className={`rounded-lg border px-4 py-2 text-[13px] ${selected === l.id ? "border-brand bg-brand-soft font-semibold text-brand" : "border-rule bg-surface text-ink-soft"}`}>
        {l.label}{sent.includes(l.id) ? " · Sent" : ""}
      </a>)}
  </nav>;
}
