import { NextResponse } from "next/server";
import { repo } from "@/data/store";
import { buildPreparedCv, extractCareer141BoxFromText, isSystemNote, preparedCvFileName, stampPdfWithCareer141Box, type CvAnnotation } from "@/lib/pdf";
import { currentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import { primeStore } from "@/data/prime";
import { storeMode } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { internalUploadUrl } from "@/lib/convexServer";

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
  const assignment = repo.assignmentFor(app.openingId, user.id) ?? null;
  const seat = seatFor(user, assignment?.role ?? null);
  if (
    !allows(user, "opening.read", { openingId: app.openingId, assignment }) ||
    (seat.stages !== null && !seat.stages.includes(app.stage))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await primeStore({ candidateIds: [app.candidateId] });
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

  const curSal = url.searchParams.get("current") ?? c.currentSalary ?? "";
  const expSal = url.searchParams.get("expected") ?? c.expectedSalary ?? "";
  const npVal = url.searchParams.get("notice") ?? (c.noticePeriodDays != null ? String(c.noticePeriodDays) : "");
  const notesList = notes.length
    ? notes
    : (app.notes && app.notes.some((n) => !isSystemNote(n)))
      ? app.notes.map((n) => n.replace(/^>/, "").trim()).filter((n) => !isSystemNote(n))
      : [];

  const annotation: CvAnnotation = {
    currentSalary: curSal,
    expectedSalary: expSal,
    noticePeriod: npVal,
    notes: notesList,
  };

  // If in Convex mode and the candidate has a real CV file in storage,
  // fetch the real PDF and stamp or update the Career141 box on page 1.
  if (storeMode() === "convex") {
    try {
      const link = await backend.cvLink({ id: null }, app.candidateId, false);
      if (link.ok && link.url) {
        const cvRes = await fetch(internalUploadUrl(link.url));
        if (cvRes.ok) {
          const baseBuffer = await cvRes.arrayBuffer();
          const stampedBytes = await stampPdfWithCareer141Box(
            baseBuffer,
            annotation,
            override,
            link.fileName ?? c.cvFileName
          );
          return new NextResponse(Buffer.from(stampedBytes), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `inline; filename="${preparedCvFileName(c.fullName)}"`,
              "Cache-Control": "private, no-store",
            },
          });
        }
      }
    } catch (err) {
      console.warn("[prepared-cv] Could not stamp original CV file, falling back to structured CV:", err);
    }
  }

  // Fallback for standalone test runner or candidates without a storage PDF
  const { pdf, placement } = buildPreparedCv(
    {
      fullName: c.fullName,
      currentTitle: c.currentTitle,
      currentEmployer: c.currentEmployer,
      location: c.location,
      totalExperienceYears: c.totalExperienceYears,
      educationDegree: c.educationDegree,
      educationInstitution: c.educationInstitution,
      summary: null,
      career: [],
      education: [],
      skills: c.skills ?? [],
      languages: [],
      certifications: [],
    },
    annotation,
    override,
  );

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${preparedCvFileName(c.fullName)}"`,
      "X-Annotation-Placement": placement.where,
      "X-Annotation-Own-Page": String(placement.ownPage),
    },
  });
}
