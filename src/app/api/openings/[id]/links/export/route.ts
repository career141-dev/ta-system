import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import type { LinkVaultEntry } from "@/data/types";
import { matchesQuery } from "@/lib/paging";
import { buildXlsx, toTsv, EXCEL_TABLES_EXPORT_HEADERS } from "@/lib/xlsx";
import { getScopedLinkVaultEntries, formatExportRowsForEntries } from "@/lib/linkExport";

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

  const { entries, facts, userNames, canSeeLeadNotes } = getScopedLinkVaultEntries(openingId, user);

  const sp = new URL(req.url).searchParams;
  const q = sp.get("q") ?? "";
  const status = sp.get("status") ?? "";
  const level = Math.max(0, Math.floor(Number(sp.get("level"))) || 0);
  const addons = sp.get("addons") === "1" || sp.get("addons") === "true";
  const by = sp.get("by") ?? "";
  const imark = sp.get("imark") === "1";
  const exportAll = sp.get("all") === "1";

  type F = { status: string; level: number; addons: boolean; imark: boolean; by: string };
  const pass = (r: LinkVaultEntry, f: F) => {
    const x = facts.get(r.id);
    return (
      (!f.status || x?.interest === f.status) &&
      (!f.level || r.level === f.level) &&
      (!f.addons || !!r.isAddOn) &&
      (!f.imark || r.isEyeMarked) &&
      (!f.by || r.addedBy === f.by)
    );
  };

  const rowsToExport = exportAll
    ? entries
    : entries
        .filter((r) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber))
        .filter((r) => pass(r, { status, level, addons, imark, by }));

  const formattedRows = formatExportRowsForEntries(rowsToExport, facts, userNames, canSeeLeadNotes);

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
