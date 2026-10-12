import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { can, isDeskWide } from "@/lib/auth";
import { scopeLinks } from "@/lib/visibility";
import { interestOf } from "@/lib/linkViews";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";
import { matchesQuery } from "@/lib/paging";
import { buildXlsx, formatLinkVaultExportRows, toTsv, EXCEL_TABLES_EXPORT_HEADERS } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

/**
 * Export Excel Tables links for an opening as a real OpenXML (.xlsx) file.
 *
 * Respects access control (scopeLinks): regular TAs only export rows they own
 * or that a lead shared with them. Leads, Directors and TA Support export
 * according to desk-wide visibility.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: openingId } = await params;
  await primeStore({ openingId });
  const user = await currentUser();

  if (!user) {
    return new Response("Sign in first.", { status: 401 });
  }

  if (!can(user, "opening.sourcing").ok) {
    return new Response("Not allowed.", { status: 403 });
  }

  const opening = repo.opening(openingId);
  if (!opening) {
    return new Response("Opening not found.", { status: 404 });
  }

  const users = repo.users();
  const canSeeLeadNotes = can(user, "link.note").ok;
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const deskWide = new Set(users.filter(isDeskWide).map((u) => u.id));
  const everyRow = scopeLinks(repo.linkVault(openingId), user, (id) => deskWide.has(id));

  const sp = new URL(req.url).searchParams;
  const q = sp.get("q") ?? "";
  const status = sp.get("status") ?? "";
  const level = Math.max(0, Math.floor(Number(sp.get("level"))) || 0);
  const addons = sp.get("addons") === "1" || sp.get("addons") === "true";
  const by = sp.get("by") ?? "";
  const exportAll = sp.get("all") === "1";

  const facts = new Map(
    everyRow.map(({ row: r }) => {
      const found = r.candidateId
        ? repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId)
        : undefined;
      const app = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
      return [r.id, { app, interest: interestOf(r, app) }] as const;
    })
  );

  type F = { status: string; level: number; addons: boolean; by: string };
  const pass = (r: (typeof everyRow)[number]["row"], f: F) => {
    const x = facts.get(r.id)!;
    return (
      (!f.status || x.interest === f.status) &&
      (!f.level || r.level === f.level) &&
      (!f.addons || !!r.isAddOn) &&
      (!f.by || r.addedBy === f.by)
    );
  };

  const rowsToExport = exportAll
    ? everyRow.map((x) => x.row)
    : everyRow
        .filter(({ row: r }) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber))
        .filter(({ row }) => pass(row, { status, level, addons, by }))
        .map((x) => x.row);

  const formattedRows = formatLinkVaultExportRows(
    rowsToExport.map((r) => {
      const fact = facts.get(r.id);
      const latestLeadNote = canSeeLeadNotes && r.leadNotes && r.leadNotes.length > 0
        ? r.leadNotes[r.leadNotes.length - 1]?.note
        : null;
      const latestApproach =
        r.conversationLog && r.conversationLog.length > 0 ? r.conversationLog[r.conversationLog.length - 1]?.note : null;
      const noteText = latestLeadNote || latestApproach || "";

      return {
        ...r,
        interest: fact?.interest,
        addedByName: userNames[r.addedBy],
        notes: noteText,
      };
    })
  );

  const format = sp.get("format") ?? "xlsx";

  if (format === "tsv") {
    const tsvContent = toTsv([...EXCEL_TABLES_EXPORT_HEADERS], formattedRows);
    return new Response(tsvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/tab-separated-values; charset=utf-8",
        "Cache-Control": "private, no-cache",
      },
    });
  }

  if (format === "json") {
    return Response.json({
      headers: [...EXCEL_TABLES_EXPORT_HEADERS],
      rows: formattedRows,
      count: formattedRows.length,
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  const safeJobTitle = opening.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);
  const sheetName = level ? `L${level}` : "Excel Tables";
  const filename = `career141-${safeJobTitle}-excel-tables-${stamp}.xlsx`;

  const buffer = buildXlsx({
    name: sheetName,
    headers: [...EXCEL_TABLES_EXPORT_HEADERS],
    rows: formattedRows,
  });

  return new Response(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}
