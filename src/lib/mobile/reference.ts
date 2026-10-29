import { repo } from "@/data/store";
import { STAGE_LABEL, type User } from "@/data/types";
import type { ReferencePayload } from "@/lib/mobile/referenceTypes";
import { seatFor } from "@/lib/visibility";

/** The opening reference desk, scoped exactly like the website's sourcing rail. */
export function mobileReference(user: User, openingId: string, company = ""): ReferencePayload | null {
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  if (!opening || !client) return null;
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  if (!seatFor(user, assignment?.role ?? null, onStrategy).canSeeSourcing) return null;

  const groups = repo.refereesForPipeline(openingId);
  const all = groups.flatMap((group) => group.referees);
  const targetCompanies = [...new Set(repo.linkVault(openingId).map((row) => row.company).filter(Boolean))] as string[];
  const searchedCompany = company.trim();
  return {
    apiVersion: 1,
    context: { openingId, title: opening.title, clientName: client.name },
    stats: {
      referees: all.length,
      candidates: groups.length,
      withPhone: all.filter((row) => row.phone).length,
      targetCompanies: targetCompanies.length,
    },
    candidates: groups.map(({ app, candidate, referees }) => ({
      applicationId: app.id,
      candidateId: candidate!.id,
      name: candidate!.fullName,
      stage: app.stage,
      stageLabel: STAGE_LABEL[app.stage],
      referees: referees.map((row) => ({
        id: row.id,
        name: row.name,
        title: row.title,
        company: row.company,
        phone: row.phone,
        email: row.email,
        relationship: row.relationship,
      })),
    })),
    targetCompanies,
    backchannel: searchedCompany ? {
      company: searchedCompany,
      people: repo.peopleAtCompany(searchedCompany).slice(0, 8).map((row) => ({
        id: row.id,
        name: row.fullName,
        title: row.currentTitle,
        phone: row.phone,
        email: row.email,
      })),
    } : null,
  };
}
