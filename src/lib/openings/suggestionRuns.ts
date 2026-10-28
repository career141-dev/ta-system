import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import type { Opening } from "@/data/types";
import { markTablesStale } from "@/data/primeState";
import { convexMutation } from "@/lib/convexServer";
import { canonicalProfile } from "@/lib/serper";
import { MAX_ROUNDS, runSourcing } from "@/lib/sourcing";

export type SourceRun = { found: number; scanned: number; queries: number; cost: number; rejected?: number; note?: string; error?: string };

const running = new Set<string>();
async function alone<T>(key: string, busy: T, work: () => Promise<T>): Promise<T> {
  if (running.has(key)) return busy;
  running.add(key);
  try { return await work(); }
  finally { running.delete(key); }
}

function withJobDetails(opening: Opening): string {
  const requirements = opening.requirements;
  const jd = opening.jdMarkdown || opening.title;
  if (!requirements || (requirements.status !== "extracted" && !requirements.editedAt)) return jd;
  const lines = [
    requirements.requiredSkills.length ? `Required skills: ${requirements.requiredSkills.join(", ")}` : "",
    requirements.niceToHaveSkills.length ? `Nice to have: ${requirements.niceToHaveSkills.join(", ")}` : "",
    requirements.experienceMinYears ? `Experience: ${requirements.experienceMinYears}${requirements.experienceMaxYears ? `–${requirements.experienceMaxYears}` : "+"} years` : "",
    requirements.seniorityLevel ? `Seniority: ${requirements.seniorityLevel.replace(/_/g, " ")}` : "",
    requirements.location ? `Location: ${requirements.location}` : "",
    requirements.educationLevel ? `Education: ${requirements.educationLevel.replace(/_/g, " ")}` : "",
    requirements.languagesRequired.length ? `Languages: ${requirements.languagesRequired.join(", ")}` : "",
  ].filter(Boolean);
  return lines.length ? `${jd}\n\n## Job details (reviewed)\n${lines.map((line) => `- ${line}`).join("\n")}` : jd;
}

function salaryNoteOf(opening: Opening): string {
  const requirements = opening.requirements;
  if (!requirements || (requirements.salaryMin == null && requirements.salaryMax == null)) return "";
  const currency = requirements.salaryCurrency ?? "LKR";
  const format = (value: number | null) => value == null ? "" : value.toLocaleString("en-US");
  if (requirements.salaryMin != null && requirements.salaryMax != null) return `${currency} ${format(requirements.salaryMin)} - ${format(requirements.salaryMax)}`;
  return requirements.salaryMax != null ? `up to ${currency} ${format(requirements.salaryMax)}` : `from ${currency} ${format(requirements.salaryMin)}`;
}

/** The Suggestions search shared by web actions and mobile-triggered Research correction. */
export function sourceFor(openingId: string, forUserId?: string, extraRound = false): Promise<SourceRun> {
  return alone(`suggest:${openingId}`, { found: 0, scanned: 0, queries: 0, cost: 0, error: "running" }, () => sourceForNow(openingId, forUserId, extraRound));
}

async function sourceForNow(openingId: string, forUserId?: string, extraRound = false): Promise<SourceRun> {
  const opening = repo.opening(openingId);
  if (!opening) return { found: 0, scanned: 0, queries: 0, cost: 0, error: "no_opening" };
  const client = repo.client(opening.clientId);
  const existing = repo.suggestions(openingId);
  const round = existing.length ? Math.max(...existing.map((row) => row.round)) + 1 : 1;
  if (round > MAX_ROUNDS && !extraRound) return { found: 0, scanned: 0, queries: 0, cost: 0, error: "rounds_spent" };
  const alreadyKnown = [
    ...repo.linkVault(openingId).map((row) => canonicalProfile(row.linkedinUrl)),
    ...existing.map((row) => canonicalProfile(row.linkedinUrl ?? "")),
  ].filter((value): value is string => Boolean(value));
  const result = await runSourcing({
    title: opening.title, clientName: client?.name ?? "the client", clientCompanyNames: [client?.name ?? ""].filter(Boolean),
    clientNotes: client?.researchNotes, jdText: withJobDetails(opening), locations: opening.locations,
    targetNationalities: opening.targetNationalities, targetGender: opening.targetGender,
    salaryNote: opening.packageNotes || salaryNoteOf(opening),
    targetEmployers: repo.benchmarks(openingId).filter((row) => row.isSelected).map((row) => row.company), alreadyKnown,
  }, round);
  if (result.error) return { found: 0, scanned: result.scanned, queries: result.queries.length, cost: result.cost, error: result.error };
  repo.addSuggestions(openingId, result.suggestions.map((row) => ({ ...row, openingId, generatedFor: forUserId ?? null, keptBy: null })));
  if (isConvex()) {
    await convexMutation("ta/workdays:recordSourcingRun", { jobId: openingId, ...(forUserId ? { userId: forUserId } : {}), round, count: result.suggestions.length });
    markTablesStale();
  }
  return { found: result.suggestions.length, scanned: result.scanned, queries: result.queries.length, cost: result.cost,
    rejected: result.rejected ?? 0, note: result.note };
}
