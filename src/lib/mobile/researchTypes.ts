/** Native Research contract. Kept identical across backend and TA_APP. */
export interface ResearchPayload {
  apiVersion: 1;
  context: {
    openingId: string;
    title: string;
    clientName: string;
    clientIndustry: string;
    workingStage: string;
    canConfirm: boolean;
  };
  run: { hasReport: boolean; seniorRole: boolean; canRerun: boolean };
  clientIdentity: { researchNotes: string; websiteLink: string; socialMedia: string };
  fields: ResearchFieldsPayload;
  editedFields: string[];
  competitors: ResearchCompetitorPayload[];
  sources: ResearchSourcePayload[];
  generated: { at: number; model: string; searches: number } | null;
  benchmark: { picked: number; canRerun: boolean; entries: ResearchBenchmarkPayload[] };
}

export interface ResearchFieldsPayload {
  similarDesignation: string;
  websiteLink: string;
  servicesProvider: string[];
  country: string;
  location: string;
  competitors: string[];
  socialMedia: string;
  companyOverview: string;
}

export interface ResearchSourcePayload { title: string; url: string }

export interface ResearchCompetitorPayload {
  name: string;
  website: string;
  linkedin: string;
  whatTheyDo: string;
  location: string;
  summary: string;
  sources: ResearchSourcePayload[];
}

export interface ResearchBenchmarkPayload {
  id: string;
  name: string | null;
  title: string;
  company: string;
  linkedinUrl: string | null;
  kind: "incumbent" | "predecessor" | "competitor";
  confidence: "high" | "medium" | "low";
  note: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  isSelected: boolean;
}

export type ResearchWriteBody =
  | { action: "run_research" }
  | { action: "correct_client"; researchNotes: string }
  | { action: "edit_field"; field: keyof ResearchFieldsPayload; value: string }
  | { action: "run_benchmark" }
  | { action: "toggle_benchmark"; entryId: string }
  | { action: "confirm"; unavailable: Partial<Record<keyof ResearchFieldsPayload, string>> };
