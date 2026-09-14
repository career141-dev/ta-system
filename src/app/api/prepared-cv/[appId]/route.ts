import { NextResponse } from "next/server";
import { repo } from "@/data/store";
import { buildPreparedCv, preparedCvFileName } from "@/lib/pdf";
import { currentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const app = repo.application(appId);
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A CV is the candidate's personal data. Only somebody who can see this
  // application on its opening gets the file — the same test as the page.
  const assignment = repo.assignmentFor(app.openingId, user.id) ?? null;
  const seat = seatFor(user, assignment?.role ?? null);
  if (!allows(user, "opening.read", { openingId: app.openingId, assignment }) ||
      (seat.stages !== null && !seat.stages.includes(app.stage))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const c = repo.candidate(app.candidateId);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  const ox = Number(url.searchParams.get("x"));
  const oy = Number(url.searchParams.get("y"));
  const override =
    Number.isFinite(ox) && Number.isFinite(oy) && (ox || oy) ? { x: ox, y: oy } : undefined;
  const notes = (url.searchParams.get("notes") ?? "")
    .split("\n")
    .map((n) => n.replace(/^[->•*]\s*/, "").trim())
    .filter(Boolean);

  const { pdf, placement } = buildPreparedCv(
    {
      fullName: c.fullName,
      currentTitle: c.currentTitle,
      currentEmployer: c.currentEmployer,
      location: c.location,
      totalExperienceYears: c.totalExperienceYears,
      educationDegree: c.educationDegree,
      educationInstitution: c.educationInstitution,
    },
    {
      currentSalary: url.searchParams.get("current") ?? c.currentSalary ?? "",
      expectedSalary: url.searchParams.get("expected") ?? c.expectedSalary ?? "",
      notes: notes.length ? notes : app.notes.map((n) => n.replace(/^>/, "").trim()),
    },
    override,
  );

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${preparedCvFileName(c.fullName)}"`,
      // So the composer can say where it landed, and warn if it had to move.
      "X-Annotation-Placement": placement.where,
      "X-Annotation-Own-Page": String(placement.ownPage),
    },
  });
}
