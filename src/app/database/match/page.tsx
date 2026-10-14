import Link from "next/link";
import { colomboGreeting } from "@/lib/calendar";
import { pageUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { DbTabs } from "@/components/db/DbTabs";
import { CvMatcher } from "@/components/db/CvMatcher";
import { searchLookalikes, type LookalikeCandidateMatch } from "@/lib/lookalikeMatch";
import type { ReferenceCvBlueprint } from "@/lib/referenceCv";

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function MatchByCvPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  await primeStore({ allApplications: true });
  const user = await pageUser("database.read");

  const candidateId = one(sp.candidateId).trim();
  let initialBlueprint: ReferenceCvBlueprint | null = null;
  let initialMatches: LookalikeCandidateMatch[] = [];
  let initialSource: string | null = null;

  if (candidateId) {
    const c = repo.candidate(candidateId);
    if (c) {
      initialBlueprint = {
        targetTitle: c.currentTitle || "Specialist",
        alternativeTitles: [],
        seniority: c.currentTitle?.toLowerCase().includes("senior") ? "senior" :
                   c.currentTitle?.toLowerCase().includes("lead") || c.currentTitle?.toLowerCase().includes("manager") ? "lead" :
                   c.currentTitle?.toLowerCase().includes("director") ? "executive" : "mid",
        totalExperienceYears: c.totalExperienceYears,
        minYears: c.totalExperienceYears ? Math.max(1, c.totalExperienceYears - 2) : null,
        maxYears: c.totalExperienceYears ? c.totalExperienceYears + 3 : null,
        skills: c.skills ?? [],
        employers: [c.currentEmployer, ...(c.workHistory ?? []).map((h) => h.employer)].filter((e): e is string => Boolean(e)),
        industries: c.industries ?? [],
        education: c.educationDegree ? [c.educationDegree] : [],
        summary: `${c.fullName}: ${c.currentTitle ?? "Candidate"} with ${c.totalExperienceYears ?? "several"} years of experience.`,
        suggestedQuery: `${c.currentTitle ?? ""} ${(c.skills ?? []).slice(0, 3).join(" ")}`.trim(),
      };
      initialSource = `Candidate: ${c.fullName}`;
      const searchRes = await searchLookalikes(initialBlueprint, "", 40);
      initialMatches = searchRes.matches;
    }
  }

  const allOpenings = repo.openings().map((o) => ({
    id: o.id,
    label: `${o.title} · ${repo.client(o.clientId)?.name ?? "Direct"}`,
  }));
  const existingCandidates = repo.candidates().slice(0, 100).map((c) => ({
    id: c.id,
    name: c.fullName,
    title: c.currentTitle ?? "Candidate",
  }));

  return (
    <main className="mx-auto max-w-[880px] px-4 pb-24 pt-8 sm:px-6">
      <DbTabs active="match" />

      <h1 className="text-center text-[26px] font-semibold tracking-tight text-ink">
        {colomboGreeting()}, {user.name}
      </h1>
      <p className="mb-8 mt-1.5 text-center text-[13px] text-ink-soft">
        Match and find lookalike candidates in the database using any CV as a reference profile.
      </p>

      <CvMatcher
        initialBlueprint={initialBlueprint}
        initialMatches={initialMatches}
        initialSource={initialSource}
        openings={allOpenings}
        existingCandidates={existingCandidates}
      />
    </main>
  );
}
