import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { can, isDeskWide } from "@/lib/auth";
import type { LinkVaultEntry } from "@/data/types";
import { matchesQuery } from "@/lib/paging";
import { buildXlsx, toTsv, EXCEL_TABLES_EXPORT_HEADERS } from "@/lib/xlsx";
import { getScopedLinkVaultEntries, buildLinkExportLayout } from "@/lib/linkExport";
import { workLocationView } from "@/lib/workLocations";

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
  const safeJobTitle = `${opening.title}${city ? `-${city}` : ""}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 150);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `career141-${safeJobTitle}-excel-tables-${stamp}.xlsx`;

  const buffer = buildXlsx({ sheets: layout.sheets });

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}
