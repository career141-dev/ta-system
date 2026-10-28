import { repo } from "@/data/store";
import { EMPTY_RESEARCH, type User } from "@/data/types";
import { isDeskWide } from "@/lib/auth";
import { benchmarkByDefault } from "@/lib/incumbents";
import { mobileHeadhunting } from "@/lib/mobile/headhunting";
import type { ResearchPayload } from "@/lib/mobile/researchTypes";

/** The website's complete Research record, shaped for a phone screen. */
export function mobileResearch(user: User, openingId: string): ResearchPayload | null {
  if (!mobileHeadhunting(user, openingId)) return null;
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  if (!opening || !client) return null;
  const report = repo.research(openingId);
  const fields = report?.fields ?? EMPTY_RESEARCH;
  const entries = repo.benchmarks(openingId);
  return {
    apiVersion: 1,
    context: {
      openingId, title: opening.title, clientName: client.name, clientIndustry: client.industry,
      workingStage: repo.workingStage(openingId, user.id), canConfirm: repo.workingStage(openingId, user.id) === "100%",
    },
    run: { hasReport: Boolean(report), seniorRole: benchmarkByDefault(opening.title), canRerun: isDeskWide(user) },
    clientIdentity: { researchNotes: client.researchNotes ?? "", websiteLink: fields.websiteLink, socialMedia: fields.socialMedia },
    fields: {
      similarDesignation: fields.similarDesignation, websiteLink: fields.websiteLink, servicesProvider: fields.servicesProvider,
      country: fields.country, location: fields.location, competitors: fields.competitors,
      socialMedia: fields.socialMedia, companyOverview: fields.companyOverview,
    },
    editedFields: report?.editedFields ?? [],
    competitors: (fields.competitorProfiles ?? []).map((row) => ({ ...row, sources: row.sources.map(({ title, url }) => ({ title, url })) })),
    sources: (report?.sources ?? []).map(({ title, url }) => ({ title, url })),
    generated: report ? { at: report.generatedAt, model: report.model, searches: report.searches } : null,
    benchmark: { picked: entries.filter((row) => row.isSelected).length, canRerun: isDeskWide(user), entries: entries.map((row) => ({
      id: row.id, name: row.name, title: row.title, company: row.company, linkedinUrl: row.linkedinUrl, kind: row.kind,
      confidence: row.confidence, note: row.note, sourceUrl: row.sourceUrl, sourceTitle: row.sourceTitle, isSelected: row.isSelected,
    })) },
  };
}
