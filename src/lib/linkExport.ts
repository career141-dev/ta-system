import { repo } from "@/data/store";
import type { LinkVaultEntry, User } from "@/data/types";
import { can, isDeskWide } from "@/lib/auth";
import { scopeLinks } from "@/lib/visibility";
import { interestOf } from "@/lib/linkViews";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";
import { buildXlsx, formatLinkVaultExportRows, EXCEL_TABLES_EXPORT_HEADERS } from "@/lib/xlsx";

export interface ExcelExportAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
  base64: string;
  rowCount: number;
}

/**
 * Retrieves the scoped LinkVaultEntry records and associated pipeline facts for an opening.
 * Respects access control (scopeLinks): regular TAs only see rows they own or that a lead shared.
 */
export function getScopedLinkVaultEntries(
  openingId: string,
  user: User,
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
  const entries = scoped.map((s) => s.row);

  const facts = new Map(
    entries.map((r) => {
      const found = r.candidateId
        ? repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId)
        : undefined;
      const app = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
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
      const latestApproach =
        r.conversationLog && r.conversationLog.length > 0
          ? r.conversationLog[r.conversationLog.length - 1]?.note
          : null;
      const noteText = latestLeadNote || latestApproach || "";

      return {
        ...r,
        interest: fact?.interest,
        addedByName: userNames[r.addedBy],
        notes: noteText,
      };
    }),
  );
}

/**
 * Builds the Excel attachment (.xlsx) with clickable hyperlinks for an opening's scoped candidate links.
 * Returns null if the opening has no candidate links for this user.
 */
export function buildOpeningExcelAttachment(
  openingId: string,
  user: User,
  openingTitle: string,
  options?: { sheetName?: string },
): ExcelExportAttachment | null {
  const { entries, facts, userNames, canSeeLeadNotes } = getScopedLinkVaultEntries(openingId, user);
  if (!entries.length) return null;

  const formattedRows = formatExportRowsForEntries(entries, facts, userNames, canSeeLeadNotes);
  if (!formattedRows.length) return null;

  const safeJobTitle = openingTitle.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);
  const sheetName = options?.sheetName ?? "Excel Tables";
  const filename = `career141-${safeJobTitle}-excel-tables-${stamp}.xlsx`;

  const buffer = buildXlsx({
    name: sheetName,
    headers: [...EXCEL_TABLES_EXPORT_HEADERS],
    rows: formattedRows,
  });

  return {
    filename,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
    base64: buffer.toString("base64"),
    rowCount: formattedRows.length,
  };
}
