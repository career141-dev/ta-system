import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import * as backend from "@/data/convex/backend";
import { repo } from "@/data/store";
import { allows } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import { internalUploadUrl } from "@/lib/convexServer";

/**
 * A candidate's CV file.
 *
 * The profile's "View CV" link and its inline preview both point here.
 * The server streams the file content directly with proper headers, so internal
 * storage loopback URLs (e.g. 127.0.0.1:3210) and cross-origin iframe issues
 * never break inline preview or downloads.
 *
 * `?download=1` asks for the file to be saved under its own name rather than
 * opened.
 *
 * `?app=<applicationId>` opens it from a candidate on an opening — the CV tab.
 * Access is then the opening's, the same test the tab itself makes, so a client
 * contact who may not search the database still sees the CV of someone on
 * their shortlist.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;

  const appId = req.nextUrl.searchParams.get("app");
  if (!appId || !repo.application(appId)) {
    await primeStore(appId ? { allApplications: true } : undefined);
  }
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in to open a CV.", { status: 401 });
  if (appId) {
    const app = repo.application(appId);
    const assignment = app ? (repo.assignmentFor(app.openingId, user.id) ?? null) : null;
    const seat = seatFor(user, assignment?.role ?? null);
    if (
      !app ||
      app.candidateId !== candidateId ||
      !allows(user, "opening.read", { openingId: app.openingId, assignment }) ||
      (seat.stages !== null && !seat.stages.includes(app.stage))
    ) {
      return new NextResponse("Not found.", { status: 404 });
    }
  } else if (!can(user, "database.read").ok) {
    return new NextResponse("Not found.", { status: 404 });
  }

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

  // Stream file directly to fix "This site can't be reached" when link.url points to internal loopback
  const fetchUrl = internalUploadUrl(link.url);
  try {
    const cvRes = await fetch(fetchUrl);
    if (cvRes.ok) {
      const buffer = await cvRes.arrayBuffer();
      const rawType = cvRes.headers.get("content-type") || link.fileType || "application/pdf";
      const isPdf =
        /pdf/i.test(rawType) ||
        /\.pdf$/i.test(link.fileName ?? "") ||
        !/\.(docx?|rtf|txt|png|jpe?g)$/i.test(link.fileName ?? "");
      const contentType = isPdf ? "application/pdf" : rawType;
      const download = req.nextUrl.searchParams.get("download") === "1";
      const filename = (link.fileName ?? (isPdf ? "cv.pdf" : "cv")).replace(/["\r\n]/g, "");
      const disposition = download ? `attachment; filename="${filename}"` : `inline; filename="${filename}"`;
      return new NextResponse(Buffer.from(buffer), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": disposition,
          // A CV is one candidate's, behind this route's own access test. "public"
          // would let any proxy between here and the browser keep a copy and hand
          // it to the next person who asked (review, 23 Sep).
          "Cache-Control": "private, no-store",
        },
      });
    }
  } catch (err) {
    console.warn("[cv proxy]", (err as Error).message);
  }

  return NextResponse.redirect(link.url, {
    status: 302,
    headers: {
      "Cache-Control": "private, no-store",
    },
  });
}
