import { redirect } from "next/navigation";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { referenceProfileFromBlueprint, serializeReferenceProfile } from "@/lib/referenceSearchProfile";

export default async function MatchByCvPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const candidateId = typeof sp.candidateId === "string" ? sp.candidateId.trim() : "";
  if (candidateId) {
    await primeStore({ candidateIds: [candidateId] });
    await pageUser("database.read");
    const candidate = repo.candidate(candidateId);
    if (candidate) {
      const years = candidate.totalExperienceYears;
      const profile = referenceProfileFromBlueprint({
        targetTitle: candidate.currentTitle || "Specialist",
        alternativeTitles: [],
        seniority: /director|chief|\bvp\b/i.test(candidate.currentTitle ?? "")
          ? "executive"
          : /lead|manager|head|principal/i.test(candidate.currentTitle ?? "")
            ? "lead"
            : /senior|\bsr\b/i.test(candidate.currentTitle ?? "")
              ? "senior"
              : /junior|intern|trainee|associate/i.test(candidate.currentTitle ?? "")
                ? "junior"
                : "mid",
        totalExperienceYears: years,
        minYears: years == null ? null : Math.max(0, years - 2),
        maxYears: years == null ? null : years + 3,
        skills: candidate.skills ?? [],
        coreSkills: (candidate.skills ?? []).slice(0, 6),
        supportingSkills: (candidate.skills ?? []).slice(6, 14),
        employers: [],
        industries: candidate.industries ?? [],
        education: candidate.educationDegree ? [candidate.educationDegree] : [],
        summary: "",
        suggestedQuery: candidate.currentTitle ?? "",
      }, candidate.id);
      const params = new URLSearchParams({
        q: "Find candidates similar to this reference profile.",
        ref: serializeReferenceProfile(profile),
      });
      redirect(`/database/results?${params.toString()}`);
    }
  }
  redirect("/database");
}
