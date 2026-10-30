import { primeStore } from "@/data/prime";
import { currentUser } from "@/lib/session";
import { convexActorForEmail, convexMutation, convexQuery } from "@/lib/convexServer";
import { buildXlsx } from "@/lib/xlsx";
import { excelDownloadDisposition } from "@/lib/excelFilename";

export const dynamic = "force-dynamic";

type Row = {
  name: string; email?: string; title: string; level: string; employer?: string; phone?: string; linkedinUrl?: string;
  experienceYears?: number; skills?: string; previousRole?: string; sector?: string; matchedBy: string; updatedAt: number;
};
type Page = { rows: Row[]; isDone: boolean; cursor: string };

const LABEL: Record<string, string> = { manager: "Manager", executive: "Executive", intern: "Intern", other: "Other" };
const HEADERS = ["Name", "Email", "Title", "Level", "Employer", "Phone", "LinkedIn", "Years of experience", "Skills", "Previous role", "Sector", "Matched by"];

/** ?level=executive|manager|intern|other (none = all salespeople), hasEmail=1, q=search. Same filters as the table. */
export async function GET(req: Request) {
  await primeStore();
  const user = await currentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (user.role !== "admin") return new Response("Only an admin can download this list.", { status: 403 });
  const p = new URL(req.url).searchParams;
  const level = p.get("level") || undefined;
  const auto = p.get("segment") === "automobile";
  const mod = auto ? "extras/automobileContacts" : "extras/salesContacts";
  try {
    const actor = await convexActorForEmail(user.email);
    if (!actor) return new Response("Your account is not connected to the backend.", { status: 503 });
    // Most recently updated record wins when one email appears on several candidates.
    const byEmail = new Map<string, Row>();
    const noEmail: Row[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 400; guard++) {
      const page: Page = await convexQuery<Page>(`${mod}:list`, {
        actorId: actor._id, level, hasEmail: p.get("hasEmail") === "1", search: p.get("q") || undefined, cursor, limit: 500,
      });
      for (const r of page.rows) {
        if (!r.email) { noEmail.push(r); continue; }
        const seen = byEmail.get(r.email);
        if (!seen || r.updatedAt > seen.updatedAt) byEmail.set(r.email, r);
      }
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const rows = [...byEmail.values(), ...noEmail].sort((a, b) => a.name.localeCompare(b.name));
    const label = level && LABEL[level] ? LABEL[level] : "All";
    const file = buildXlsx({
      name: `${label} ${auto ? "automobile people" : "salespeople"}`,
      headers: HEADERS,
      rows: rows.map((r) => [
        r.name, r.email ?? "", r.title, LABEL[r.level] ?? r.level, r.employer ?? "", r.phone ?? "", r.linkedinUrl ?? "",
        r.experienceYears == null ? "" : String(r.experienceYears), r.skills ?? "", r.previousRole ?? "", r.sector ?? "", r.matchedBy,
      ]),
    });
    await convexMutation(`${mod}:logExport`, { actorId: actor._id, level, rows: rows.length });
    const filename = `${auto ? "Automobile" : "Sales"} contacts - ${label} - ${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": excelDownloadDisposition(filename),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Could not build the download. Try again.", { status: 503 });
  }
}
