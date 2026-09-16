import { NextResponse } from "next/server";
import { repo } from "@/data/store";
import { buildPreparedCv, preparedCvFileName } from "@/lib/pdf";
import { currentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import { primeStore } from "@/data/prime";
import { storeMode } from "@/data/mode";
import * as backend from "@/data/convex/backend";

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
  if (!allows(user, "opening.read", { openingId: app.openingId, assignment }) ||
      (seat.stages !== null && !seat.stages.includes(app.stage))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Applications are loaded for the whole desk; the person on this one is not.
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

  // The CV's own structure, as extraction read it; without it the page has
  // only the headline fields.
  //
  // Read without an actor, as the profile page and /api/cv do: access was
  // decided above, against this opening. Passing the user made the backend
  // apply its whole-database rule (admin, ta_manager, senior_ta, test_ta), so a
  // Director, Ops or a recruiter got the headline fields only — and the refusal
  // was swallowed by the catch, so it looked like a CV with nothing in it.
  const profile =
    storeMode() === "convex"
      ? await backend.candidateProfile({ id: null }, c.id).catch((e) => {
          console.error(`[prepared-cv ${appId}] profile could not be read:`, (e as Error).message);
          return null;
        })
      : null;

  const { pdf, placement } = buildPreparedCv(
    {
      fullName: c.fullName,
      currentTitle: c.currentTitle,
      currentEmployer: c.currentEmployer,
      location: c.location,
      totalExperienceYears: c.totalExperienceYears,
      educationDegree: c.educationDegree,
      educationInstitution: c.educationInstitution,
      summary: profile?.summary ?? null,
      career: profile?.career ?? [],
      education: profile?.education ?? [],
      skills: c.skills ?? [],
      languages: profile?.languages ?? [],
      certifications: profile?.certifications ?? [],
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
