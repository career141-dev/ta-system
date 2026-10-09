import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { currentUser } from "@/lib/session";
import { repo } from "@/data/store";
import { convexQuery, internalUploadUrl } from "@/lib/convexServer";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await primeStore();
  const user = await currentUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Look up feedback item by id first, or use id directly as storageId
  const item = repo.feedback(id);
  const screenshotKey = item ? item.screenshot : id;

  if (!screenshotKey) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Support legacy base64 if any exists
  if (screenshotKey.startsWith("data:image/")) {
    const match = screenshotKey.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const contentType = match[1];
      const buffer = Buffer.from(match[2], "base64");
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
  }

  if (!isConvex()) {
    // Return empty SVG placeholder for local/test runs without Convex backend
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
      <rect width="400" height="200" fill="#f4f5f6"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#8c9196" font-family="sans-serif" font-size="14">
        Screenshot preview (local mode)
      </text>
    </svg>`;
    return new NextResponse(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const storageId = screenshotKey.replace(/^convex:/, "");
    const url = await convexQuery<string | null>("ta/feedbacks:screenshotUrl", { storageId });
    if (!url) {
      return new NextResponse("Screenshot not found in storage", { status: 404 });
    }

    const res = await fetch(internalUploadUrl(url), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return new NextResponse(`Storage answered ${res.status}`, { status: res.status });
    }

    const contentType = res.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await res.arrayBuffer());

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (err) {
    console.warn("[feedback screenshot]", (err as Error).message);
    return new NextResponse("Failed to fetch screenshot", { status: 500 });
  }
}
