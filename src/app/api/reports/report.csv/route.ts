import { reportCsv, DEFAULT_SPEC, sanitizeSpec, type ReportSpec } from "@/lib/reporting";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Whatever is on screen, as a file. The spec travels in the query string, so
 * the download is the same query the table just ran — a report and its export
 * cannot drift apart.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (!can(user, "report.read").ok) return new Response("Not allowed.", { status: 403 });
  const raw = new URL(req.url).searchParams.get("spec");
  let spec: ReportSpec = DEFAULT_SPEC;
  if (raw) {
    try {
      spec = sanitizeSpec(JSON.parse(raw), DEFAULT_SPEC);
    } catch {
      // Fall through to the default rather than failing the download.
    }
  }
  const name = (new URL(req.url).searchParams.get("name") ?? "report")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response("﻿" + reportCsv(spec), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="career141-${name}-${stamp}.csv"`,
    },
  });
}
