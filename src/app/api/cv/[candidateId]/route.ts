import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { currentUser } from "@/lib/session";
import { repo } from "@/data/store";
import { cvBytes, mayOpenCv } from "@/lib/cvAccess";

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
 * Access is then the opening's (lib/cvAccess).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;

  const appId = req.nextUrl.searchParams.get("app");
  if (!appId || !repo.application(appId)) {
    await primeStore(appId ? { allApplications: true } : undefined);
  }
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in to open a CV.", { status: 401 });
  if (!mayOpenCv(user, candidateId, appId)) return new NextResponse("Not found.", { status: 404 });

  if (!isConvex()) {
    return new NextResponse("CV files are held by the candidate database, which this build is not connected to.", {
      status: 404,
    });
  }

  const download = req.nextUrl.searchParams.get("download") === "1";
  const cv = await cvBytes(candidateId, download);
  if (cv.ok) {
    const filename = (cv.fileName ?? (cv.isPdf ? "cv.pdf" : "cv")).replace(/["\r\n]/g, "");
    return new NextResponse(new Uint8Array(cv.bytes), {
      status: 200,
      headers: {
        "Content-Type": cv.contentType,
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        // A CV is one candidate's, behind this route's own access test. "public"
        // would let any proxy between here and the browser keep a copy and hand
        // it to the next person who asked (review, 23 Sep).
        "Cache-Control": "private, no-store",
      },
    });
  }
  if (cv.url === undefined) {
    return new NextResponse(cv.detail, { status: cv.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.redirect(cv.url, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
