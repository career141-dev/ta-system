/** Location identity survives renaming and reordering. Missing means legacy/unassigned. */
export interface WorkLocation {
  id: string;
  name: string;
  vacancies: number;
  archived?: boolean;
}

export function validateWorkLocations(value: unknown, previous: WorkLocation[] = []): WorkLocation[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Add between one and 50 work locations.");
  const ids = new Set<string>();
  const names = new Set<string>();
  const rows = value.map((raw): WorkLocation => {
    if (!raw || typeof raw !== "object") throw new Error("Check the work locations.");
    const row = raw as Record<string, unknown>;
    const id = String(row.id ?? "");
    const name = String(row.name ?? "").trim();
    const vacancies = Number(row.vacancies);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error("Each work location needs a unique ID.");
    if (!name || name.length > 100) throw new Error("Enter a city or work location (up to 100 characters).");
    if (!Number.isSafeInteger(vacancies) || vacancies < 1 || vacancies > 10000) throw new Error("Vacancies must be a whole number between 1 and 10,000.");
    const archived = row.archived === true;
    if (!archived && names.has(name.toLocaleLowerCase())) throw new Error("Use one row per work location.");
    ids.add(id);
    if (!archived) names.add(name.toLocaleLowerCase());
    return { id, name, vacancies, ...(archived ? { archived: true } : {}) };
  });
  if (!rows.some(r => !r.archived)) throw new Error("Keep at least one active work location.");
  if (previous.some(r => !ids.has(r.id))) throw new Error("Archive an existing location instead of removing it, so its records stay accessible.");
  return rows;
}

export function activeWorkLocationIds(job: { workLocations?: WorkLocation[] }): string[] {
  return (job.workLocations ?? []).filter(l => !l.archived).map(l => l.id);
}

/** Empty string is an explicit unassigned view; undefined is a legacy whole-job view. */
export function inWorkLocation(row: { workLocationId?: string }, locationId?: string): boolean {
  return locationId === undefined || (row.workLocationId ?? "") === locationId;
}

export function requireWorkLocation(job: { workLocations?: WorkLocation[] }, requested?: string): WorkLocation | undefined {
  const active = (job.workLocations ?? []).filter(l => !l.archived);
  if (!job.workLocations?.length) {
    if (requested) throw new Error("That work location is not on this job.");
    return undefined;
  }
  const selected = requested || (active.length === 1 ? active[0].id : "");
  const found = active.find(l => l.id === selected);
  if (!found) throw new Error("Select an active work location first.");
  return found;
}

export function locationEodComplete(required: readonly string[] | undefined, receipts: { workLocationId?: string }[]): boolean {
  return required?.length ? required.every(id => receipts.some(r => r.workLocationId === id)) : receipts.length > 0;
}

export function workLocationView(job: { workLocations?: WorkLocation[] }, requested?: string): string | undefined {
  if (!job.workLocations?.length) return undefined;
  if (requested === "unassigned") return "";
  if (requested) {
    if (!job.workLocations.some(l => l.id === requested)) throw new Error("That work location is not on this job. Open the job again.");
    return requested;
  }
  const active = activeWorkLocationIds(job);
  return active.length === 1 ? active[0] : "";
}
