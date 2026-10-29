import type { LinkVaultEntry, User } from "@/data/types";
import { must } from "@/lib/auth";
import { colomboDay } from "@/lib/linkViews";

export interface SupportSheet {
  userId: string; level: number; workLocationId?: string; name?: string;
}

/** A TA's L1 is separate from another TA's L1 and from other locations. */
export function supportSheetCounts(user: User, rows: LinkVaultEntry[], sheets: SupportSheet[], openingId: string, taId = "", now = Date.now()) {
  must(user, "tables.readAll");
  const key = (s: SupportSheet) => JSON.stringify([s.userId, s.level, s.workLocationId ?? ""]);
  const counts = new Map<string, SupportSheet & { total: number; addedToday: number }>();
  for (const sheet of sheets) if (!taId || sheet.userId === taId) counts.set(key(sheet), { ...sheet, total: 0, addedToday: 0 });
  const today = colomboDay(now);
  for (const row of rows) {
    if (row.openingId !== openingId || (taId && row.addedBy !== taId)) continue;
    const sheet = { userId: row.addedBy, level: row.level ?? 0, workLocationId: row.workLocationId };
    const item = counts.get(key(sheet)) ?? { ...sheet, total: 0, addedToday: 0 };
    item.total++;
    if (colomboDay(row.createdAt) === today) item.addedToday++;
    counts.set(key(sheet), item);
  }
  return [...counts.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.level - b.level || (a.workLocationId ?? "").localeCompare(b.workLocationId ?? ""));
}

/** Read access is independent of assignment; existing write permissions stay scoped. */
export function supportTableRows(user: User, rows: LinkVaultEntry[], filters: {
  openingId: string; taId?: string; q?: string; level?: string; location?: string;
}): LinkVaultEntry[] {
  must(user, "tables.readAll");
  const q = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter(row => row.openingId === filters.openingId
    && (!filters.taId || row.addedBy === filters.taId)
    && (!filters.level || String(row.level ?? 0) === filters.level)
    && (!filters.location || (row.workLocationId ?? "unassigned") === filters.location)
    && (!q || [row.name, row.title, row.company, row.linkedinUrl, row.phoneNumber]
      .some(value => value?.toLowerCase().includes(q))))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
