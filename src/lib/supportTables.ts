import type { LinkVaultEntry, User } from "@/data/types";
import { must } from "@/lib/auth";

/** Read access is independent of assignment; existing write permissions stay scoped. */
export function supportTableRows(user: User, rows: LinkVaultEntry[], filters: {
  openingId: string; taId?: string; q?: string; level?: string;
}): LinkVaultEntry[] {
  must(user, "tables.readAll");
  const q = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter(row => row.openingId === filters.openingId
    && (!filters.taId || row.addedBy === filters.taId)
    && (!filters.level || String(row.level ?? 0) === filters.level)
    && (!q || [row.name, row.title, row.company, row.linkedinUrl, row.phoneNumber]
      .some(value => value?.toLowerCase().includes(q))))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
