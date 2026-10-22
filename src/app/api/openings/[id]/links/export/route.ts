import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { can, isDeskWide, seesEveryTaRow } from "@/lib/auth";
import { inDay, inSheet, readLinkFilters, sheetOwner } from "@/lib/linkViews";
import type { LinkVaultEntry } from "@/data/types";
import { matchesQuery } from "@/lib/paging";
import { buildXlsx, toTsv, EXCEL_TABLES_EXPORT_HEADERS } from "@/lib/xlsx";
import { getScopedLinkVaultEntries, buildLinkExportLayout } from "@/lib/linkExport";
import { workLocationView } from "@/lib/workLocations";
import { excelFilename, excelDownloadDisposition } from "@/lib/excelFilename";

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

  const opening = repo.opening(openingId);
  if (!opening) {
    return new Response("Opening not found.", { status: 404 });
  }

  if (user.role === "client") {
    return new Response("Not allowed.", { status: 403 });
  }

  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((r) => r.doneBy.includes(user.id));

  const allowed =
    isDeskWide(user) ||
    can(user, "opening.sourcing", { openingId, assignment, onStrategy }).ok ||
    can(user, "opening.read", { openingId, assignment, onStrategy }).ok ||
    (opening.assignedTaIds ?? []).includes(user.id) ||
    repo.linkVault(openingId).some((r) => r.addedBy === user.id);

  if (!allowed) {
    return new Response("Not allowed.", { status: 403 });
  }

  const sp = new URL(req.url).searchParams;
  let location: string | undefined;
  try { location = workLocationView(opening, sp.get("location") ?? undefined); }
  catch { return new Response("Invalid work location.", { status: 400 }); }
  const { entries, facts, userNames, canSeeLeadNotes } = getScopedLinkVaultEntries(openingId, user, location);
  const q = sp.get("q") ?? "";
  const f = readLinkFilters(Object.fromEntries(sp.entries()));
  const exportAll = sp.get("all") === "1";
  // The same cut as the screen (22 Oct): a sheet is one person's, so an L
  // counts only with someone chosen — the TA themself, or the lead's pick.
  const owner = sheetOwner(user.id, isDeskWide(user) || seesEveryTaRow(user), f.by);
  const now = Date.now();
  const pass = (r: LinkVaultEntry) => {
    const x = facts.get(r.id);
    return (
      (!f.status || x?.interest === f.status) &&
      inSheet(r, owner ? f.level : 0, owner) &&
      (!f.addons || !!r.isAddOn) &&
      (!f.imark || r.isEyeMarked) &&
      (!f.by || r.addedBy === f.by) &&
      inDay(r.createdAt, f.day, now)
    );
  };

  const rowsToExport = exportAll
    ? entries
    : entries
        .filter((r) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber))
        .filter(pass);

  const layout = buildLinkExportLayout(rowsToExport, facts, userNames, canSeeLeadNotes);

  const format = sp.get("format") ?? "xlsx";

  if (format === "tsv") {
    const tsvContent = toTsv([...EXCEL_TABLES_EXPORT_HEADERS], layout.clipboardRows);
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
      rows: layout.clipboardRows,
      count: layout.rowCount,
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  const city = opening.workLocations?.find(l => l.id === location)?.name;
  const filename = excelFilename(repo.client(opening.clientId)?.name || "Client", opening.title, city);

  const buffer = buildXlsx({ sheets: layout.sheets });

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": excelDownloadDisposition(filename),
      "Cache-Control": "private, no-cache",
    },
  });
}
