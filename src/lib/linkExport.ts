import { repo } from "@/data/store";
import type { LinkVaultEntry, User } from "@/data/types";
import { isDeskWide } from "@/lib/auth";
import { scopeLinks } from "@/lib/visibility";
import { interestOf } from "@/lib/linkViews";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";
import { buildXlsx, formatLinkVaultExportRows, uniqueSheetNames, EXCEL_TABLES_EXPORT_HEADERS, type XlsxSheet } from "@/lib/xlsx";
import { excelFilename } from "@/lib/excelFilename";
import { inWorkLocation } from "./workLocations";
import { rowApplication } from "./sharedLinks";

export interface ExcelExportAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
  base64: string;
  rowCount: number;
  linkIds: string[];
}

/**
 * Retrieves the scoped LinkVaultEntry records and associated pipeline facts for an opening.
 * Respects access control (scopeLinks): regular TAs only see rows they own or that a lead shared.
 */
export function getScopedLinkVaultEntries(
  openingId: string,
  user: User,
  workLocationId?: string,
): {
  entries: LinkVaultEntry[];
  facts: Map<string, { app: ReturnType<typeof repo.application>; interest: string }>;
  userNames: Record<string, string>;
  canSeeLeadNotes: boolean;
} {
  const users = repo.users();
  const canSeeLeadNotes = user.role !== "client";
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const deskWide = new Set(users.filter(isDeskWide).map((u) => u.id));
  const scoped = scopeLinks(repo.linkVault(openingId), user, (id) => deskWide.has(id));
  const entries = scoped.map((s) => s.row).filter(r => inWorkLocation(r, workLocationId));

  const facts = new Map(
    entries.map((r) => {
      const found = r.candidateId
        ? repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId && inWorkLocation(a, r.workLocationId ?? ""))
        : undefined;
      const onPipeline = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
      // Shortlisted first by another TA: not this TA's Interested (lib/sharedLinks).
      const { app } = rowApplication(r, onPipeline, (id) => deskWide.has(id));
      return [r.id, { app, interest: interestOf(r, app) }] as const;
    }),
  );

  return { entries, facts, userNames, canSeeLeadNotes };
}

/**
 * Formats LinkVaultEntry records into the standardized export rows matching EXCEL_TABLES_EXPORT_HEADERS.
 */
export function formatExportRowsForEntries(
  entries: LinkVaultEntry[],
  facts: Map<string, { app: ReturnType<typeof repo.application>; interest: string }>,
  userNames: Record<string, string>,
  canSeeLeadNotes: boolean,
): string[][] {
  return formatLinkVaultExportRows(
    entries.map((r) => {
      const fact = facts.get(r.id);
      const latestLeadNote =
        canSeeLeadNotes && r.leadNotes && r.leadNotes.length > 0
          ? r.leadNotes[r.leadNotes.length - 1]?.note
          : null;
      const latestTaNote =
        r.taNotes && r.taNotes.length > 0
          ? r.taNotes[r.taNotes.length - 1]?.note
          : null;
      const latestApproach =
        r.conversationLog && r.conversationLog.length > 0
          ? r.conversationLog[r.conversationLog.length - 1]?.note
          : null;
      const noteText = latestLeadNote || latestTaNote || latestApproach || "";

      return {
        ...r,
        interest: fact?.interest,
        addedByName: userNames[r.addedBy],
        notes: noteText,
      };
    }),
  );
}

/** Group only already-scoped/filtered rows; never fetch broader data here. */
export function buildLinkExportLayout(
  entries: LinkVaultEntry[],
  facts: Map<string, { app: ReturnType<typeof repo.application>; interest: string }>,
  userNames: Record<string, string>,
  canSeeLeadNotes: boolean,
): { sheets: XlsxSheet[]; clipboardRows: string[][]; rowCount: number } {
  const groups = new Map<string, { owner: string; level: number | null; entries: LinkVaultEntry[] }>();
  for (const entry of entries) {
    const level = entry.level && Number.isInteger(entry.level) && entry.level > 0 ? entry.level : null;
    const key = JSON.stringify([entry.addedBy, level]);
    if (!groups.has(key)) groups.set(key, { owner: entry.addedBy, level, entries: [] });
    groups.get(key)!.entries.push(entry);
  }
  const ownerName = (id: string) => userNames[id] || "Unknown TA";
  const ordered = [...groups.values()].sort((a, b) =>
    ownerName(a.owner).localeCompare(ownerName(b.owner), "en") ||
    a.owner.localeCompare(b.owner, "en") ||
    (a.level ?? Infinity) - (b.level ?? Infinity));
  // Reserve space for the level so a long TA name cannot hide L1 versus L2.
  const names = uniqueSheetNames(ordered.map((group) => {
    // "Unassigned" read as Location not assigned (22 Oct).
    const suffix = group.level === null ? " Not in a sheet" : ` L${group.level}`;
    return ownerName(group.owner).slice(0, 31 - suffix.length) + suffix;
  }));
  const sheets: XlsxSheet[] = ordered.map((group, i) => {
    const orderedEntries = [...group.entries].sort((a, b) =>
      (a.name || a.capture?.fullName || "—").localeCompare(b.name || b.capture?.fullName || "—", "en") ||
      a.id.localeCompare(b.id, "en"));
    const formatted = formatExportRowsForEntries(orderedEntries, facts, userNames, canSeeLeadNotes);
    const rows: string[][] = [];
    const sectionRows: number[] = [];
    for (const status of ["Interested", "Pending", "Not Interested"]) {
      const selected = formatted.filter((row) => row[2] === status);
      if (!selected.length) continue;
      if (rows.length) rows.push(["", "", "", ""]);
      sectionRows.push(rows.length);
      rows.push([status, "", "", ""], ...selected);
    }
    return { name: names[i], headers: [...EXCEL_TABLES_EXPORT_HEADERS], rows, sectionRows };
  });
  if (!sheets.length) sheets.push({ name: "Excel Tables", headers: [...EXCEL_TABLES_EXPORT_HEADERS], rows: [] });
  // Clipboard formats cannot have tabs. Keep the same four columns with explicit sheet labels.
  const clipboardRows = entries.length ? sheets.flatMap((sheet, i) => [
    ...(i ? [["", "", "", ""]] : []),
    [sheet.name!, "", "", ""],
    ...sheet.rows,
  ]) : [];
  return { sheets, clipboardRows, rowCount: entries.length };
}

/**
 * Builds the Excel attachment (.xlsx) with clickable hyperlinks for an opening's scoped candidate links.
 * Returns null if the opening has no candidate links for this user.
 */
export function buildOpeningExcelAttachment(
  openingId: string,
  user: User,
  openingTitle: string,
  workLocationId?: string,
): ExcelExportAttachment | null {
  const { entries, facts, userNames, canSeeLeadNotes } = getScopedLinkVaultEntries(openingId, user, workLocationId);
  if (!entries.length) return null;

  const layout = buildLinkExportLayout(entries, facts, userNames, canSeeLeadNotes);

  const opening = repo.opening(openingId);
  const location = opening?.workLocations?.find(l => l.id === workLocationId);
  const filename = excelFilename(opening ? repo.client(opening.clientId)?.name || "Client" : "Client", openingTitle, location?.name);

  const buffer = buildXlsx({ sheets: layout.sheets });

  return {
    filename,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
    base64: buffer.toString("base64"),
    rowCount: layout.rowCount,
    linkIds: entries.map(r => r.id),
  };
}
