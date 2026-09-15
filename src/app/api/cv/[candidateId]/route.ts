import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import * as backend from "@/data/convex/backend";

/**
 * A candidate's CV file.
 *
 * The profile's "View CV" link and its inline preview both point here. The
 * answer is a redirect to a short-lived link — an R2 URL signed for an hour, or
 * the backend's own storage URL — so the file itself never passes through this
 * server and nothing about where it lives is written into the page.
 *
 * `?download=1` asks for the file to be saved under its own name rather than
 * opened.
 *
 * Why not the old app's `/api/r2-file?key=`: it signed whatever key it was
 * handed, so anyone signed in could open any object in the bucket by guessing a
 * path. This takes a candidate id, checks the person may read the database, and
 * looks the key up itself.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;

  await primeStore();
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in to open a CV.", { status: 401 });
  if (!can(user, "database.read").ok) return new NextResponse("Not found.", { status: 404 });

  if (!isConvex()) {
    return new NextResponse("CV files are held by the candidate database, which this build is not connected to.", {
      status: 404,
    });
  }

  const link = await backend.cvLink({ id: null }, candidateId, req.nextUrl.searchParams.get("download") === "1");
  if (!link.ok) {
    const status = link.reason === "storage_unavailable" ? 503 : 404;
    return new NextResponse(link.detail, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.redirect(link.url, { status: 302, headers: { "cache-control": "private, no-store" } });
}
