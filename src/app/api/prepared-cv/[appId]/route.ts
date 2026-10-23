import { NextResponse } from "next/server";
import { repo } from "@/data/store";
import { preparedCvFileName } from "@/lib/pdf";
import { boxContent } from "@/lib/preparedCv";
import { preparedCvFile } from "@/lib/preparedCvFile";
import { currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { mayOpenCv } from "@/lib/cvAccess";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const app = repo.application(appId);
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  // A CV is the candidate's personal data. Only somebody who can see this
  // application on its opening gets the file — the same test as the page.
  if (!mayOpenCv(user, app.candidateId, app.id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await primeStore({ candidateIds: [app.candidateId] });
  const c = repo.candidate(app.candidateId);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  const q = url.searchParams;
  // A one-off preview may pass a position or the box's contents; without them
  // the file is what the desk holds, with the box where the TA last put it.
  const ox = Number(q.get("x"));
  const oy = Number(q.get("y"));
  const ow = Number(q.get("width"));
  const at = q.has("x") && q.has("y") && Number.isFinite(ox) && Number.isFinite(oy)
    ? { x: ox, y: oy, ...(q.has("width") && Number.isFinite(ow) ? { width: ow } : {}) }
    : undefined;
  const asked = ["designation", "company", "current", "expected", "notice", "notes"].some((k) => q.has(k));
  const held = boxContent(app, c, repo.opening(app.openingId));
  const annotation = asked
    ? {
        currentDesignation: q.get("designation") ?? held.currentDesignation,
        currentCompany: q.get("company") ?? held.currentCompany,
        currentSalary: q.get("current") ?? held.currentSalary,
        expectedSalary: q.get("expected") ?? held.expectedSalary,
        noticePeriod: q.get("notice") ?? held.noticePeriod,
        notes: q.has("notes")
          ? (q.get("notes") ?? "").split("\n").map((n) => n.replace(/^[->•*]\s*/, "").trim()).filter(Boolean)
          : held.notes,
      }
    : undefined;

  const file = await preparedCvFile(app, c, repo.opening(app.openingId), { annotation, at });

  // The Prepared CV tab asks where the box is, to draw it for dragging.
  if (q.get("layout") === "1") {
    return NextResponse.json({ box: file.box, page: file.page, generated: file.generated }, { headers: { "Cache-Control": "private, no-store" } });
  }

  return new NextResponse(Buffer.from(file.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${q.get("download") === "1" ? "attachment" : "inline"}; filename="${preparedCvFileName(c.fullName)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
