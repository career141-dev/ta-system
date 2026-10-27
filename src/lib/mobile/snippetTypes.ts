/** Native social-snippet contract. Kept identical across backend and TA_APP. */
export interface SnippetPayload {
  apiVersion: 1;
  context: { openingId: string; title: string; clientName: string };
  approved: boolean;
  fields: SnippetFields | null;
  levels: { key: LevelKey; label: string; swatch: string }[];
}

export type LevelKey = "JUNIOR" | "EXECUTIVE" | "MID LEVEL" | "SENIOR" | "C LEVEL";

export interface SnippetFields {
  jobTitle: string;
  titleLead?: string;
  titleMain?: string;
  level: LevelKey;
  industry: string;
  location: string;
  company: string;
  package: string;
  gender: string;
  bullets: string[];
  email: string;
  mobile: string;
}

export interface SnippetRefineResult {
  ok: boolean;
  data?: Pick<SnippetFields, "titleLead" | "titleMain" | "industry" | "location" | "company" | "package" | "gender" | "bullets">;
  error?: string;
}
