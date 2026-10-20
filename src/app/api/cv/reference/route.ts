import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { extractBlueprintFromFile, extractBlueprintFromText, type ReferenceCvBlueprint } from "@/lib/referenceCv";
import { MAX_REFERENCE_CV_BYTES, referenceCvFileProblem } from "@/lib/referenceCvFile";
import { safeErrorMessage } from "@/lib/userError";

const MAX_BYTES = MAX_REFERENCE_CV_BYTES;
const TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "text/plain": "Text",
};

const answer = (data: Record<string, unknown>, status = 200) =>
  NextResponse.json(data, { status });

export async function POST(req: NextRequest) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) {
    return answer({ ok: false, message: "That file is over 10 MB. Please choose a smaller document." }, 413);
  }

  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) {
    return answer({ ok: false, message: "Your session has ended. Please sign in again." }, 401);
  }

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const json = await req.json().catch(() => null);
      if (!json) return answer({ ok: false, message: "Invalid JSON request." }, 400);

      const candidateId = typeof json.candidateId === "string" ? json.candidateId.trim() : "";
      if (candidateId) {
        const c = repo.candidate(candidateId);
        if (!c) return answer({ ok: false, message: "Candidate not found." }, 404);

        const blueprint: ReferenceCvBlueprint = {
          targetTitle: c.currentTitle || "Specialist",
          alternativeTitles: [],
          seniority: c.currentTitle?.toLowerCase().includes("senior") ? "senior" :
                     c.currentTitle?.toLowerCase().includes("lead") || c.currentTitle?.toLowerCase().includes("manager") ? "lead" :
                     c.currentTitle?.toLowerCase().includes("director") ? "executive" : "mid",
          totalExperienceYears: c.totalExperienceYears,
          minYears: c.totalExperienceYears ? Math.max(1, c.totalExperienceYears - 2) : null,
          maxYears: c.totalExperienceYears ? c.totalExperienceYears + 3 : null,
          skills: c.skills ?? [],
          coreSkills: (c.skills ?? []).slice(0, 6),
          supportingSkills: (c.skills ?? []).slice(6, 14),
          employers: [c.currentEmployer, ...(c.workHistory ?? []).map((h) => h.employer)].filter((e): e is string => Boolean(e)),
          industries: c.industries ?? [],
          education: c.educationDegree ? [c.educationDegree] : [],
          summary: `${c.fullName}: ${c.currentTitle ?? "Candidate"} with ${c.totalExperienceYears ?? "several"} years of experience.`,
          suggestedQuery: `${c.currentTitle ?? ""} ${(c.skills ?? []).slice(0, 3).join(" ")}`.trim(),
        };

        return answer({ ok: true, blueprint, source: `Candidate profile: ${c.fullName}` });
      }

      const text = typeof json.text === "string" ? json.text.trim() : "";
      if (!text || text.length < 20) {
        return answer({ ok: false, message: "Please provide more CV content (at least 20 characters)." }, 400);
      }

      const blueprint = await extractBlueprintFromText(text);
      return answer({ ok: true, blueprint, source: "Pasted text" });
    }

    // Multipart form upload
    const form = await req.formData().catch(() => null);
    if (!form) return answer({ ok: false, message: "The upload could not be read." }, 400);

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return answer({ ok: false, message: "Please select a PDF, DOCX or TXT CV." }, 400);
    }
    const fileProblem = referenceCvFileProblem(file.name, file.size);
    if (fileProblem) return answer({ ok: false, message: fileProblem }, file.size > MAX_BYTES ? 413 : 400);

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isDocx = TYPES[file.type] === "Word" || /\.docx$/i.test(file.name);
    const isText = TYPES[file.type] === "Text" || /\.txt$/i.test(file.name);
    if (!isPdf && !isDocx && !isText) {
      return answer({ ok: false, message: "A reference CV must be a PDF, DOCX or TXT file." }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { blueprint, text } = await extractBlueprintFromFile(buffer, file.type || (isPdf ? "application/pdf" : isDocx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain"));

    return answer({
      ok: true,
      blueprint,
      fileName: file.name,
      fileSize: file.size,
      textSnippet: text.slice(0, 300),
    });
  } catch (err) {
    console.warn("[api/cv/reference]", err);
    return answer({ ok: false, message: safeErrorMessage(err, "The reference CV could not be read. Try a PDF, DOCX or TXT file.") }, 500);
  }
}
