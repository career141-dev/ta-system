import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { allows } from "@/lib/auth";
import type { SnippetPayload } from "@/lib/mobile/snippetTypes";
import { LEVELS, snippetFromOpening } from "@/lib/snippet";

/** The native screen reads the same approved-JD projection as the website. */
export function mobileSnippet(user: User, openingId: string): SnippetPayload | null {
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  if (!opening || !client) return null;
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  if (!allows(user, "opening.sourcing", { openingId, assignment, onStrategy })) return null;
  return {
    apiVersion: 1,
    context: { openingId, title: opening.title, clientName: client.name },
    approved: opening.jdStatus === "approved",
    fields: opening.jdStatus === "approved" ? snippetFromOpening({
      title: opening.title,
      clientIndustry: client.industry,
      locations: opening.locations,
      salaryMin: opening.salaryMin,
      salaryMax: opening.salaryMax,
      currency: opening.salaryCurrency,
      packageNotes: opening.packageNotes,
      jdMarkdown: opening.jdMarkdown,
      taEmail: user.email,
      taPhone: user.phone ?? null,
    }) : null,
    levels: LEVELS.map((level) => ({ key: level.key, label: level.pill, swatch: level.swatch })),
  };
}
