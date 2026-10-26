/** Native Job description contract. Kept identical across backend and TA_APP. */
export interface JdPayload {
  apiVersion: 1;
  consentText: string;
  context: { openingId: string; title: string; clientName: string };
  status: "draft" | "approved";
  access: { canWrite: boolean; canAmend: boolean; assignedTo: string[] };
  notes: {
    mine: string;
    others: { id: string; author: string; kind: "Brief" | "Notes"; body: string; at: number }[];
    extractedSummary: string[];
  };
  document: { markdown: string; approvedBy: string | null; approvedAt: number | null };
  chat: { id: string; role: "user" | "assistant"; body: string; at: number; author: string | null; hasVersion: boolean; failed: boolean }[];
  requirements: {
    requiredSkills: string[];
    niceToHaveSkills: string[];
    seniorityLevel: string | null;
    experienceMinYears: number | null;
    experienceMaxYears: number | null;
    location: string | null;
    educationLevel: string | null;
    languagesRequired: string[];
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    clientIndustry: string | null;
    recruitmentType: "both" | "headhunting" | "job_posting";
    isConfidential: boolean;
    jobStatus: string;
    status: "extracting" | "extracted" | "failed" | null;
    extractedAt: number | null;
    error: string | null;
    lockedFields: string[];
    editedByName: string | null;
    editedAt: number | null;
  } | null;
}

export type JdWriteBody =
  | { action: "save_notes"; notes: string }
  | { action: "generate"; notes: string }
  | { action: "approve"; markdown: string }
  | { action: "amend"; markdown: string }
  | { action: "revise"; request: string; currentMarkdown: string }
  | { action: "restore"; messageId: string }
  | { action: "save_details"; details: JdDetailsBody }
  | { action: "reextract_details" };

export interface JdDetailsBody {
  title: string;
  clientIndustry: string;
  recruitmentType: "both" | "headhunting" | "job_posting";
  isConfidential: boolean;
  jobStatus: "active" | "draft" | "on_hold";
  location: string;
  seniorityLevel: string;
  experienceMinYears: number;
  experienceMaxYears: number | null;
  educationLevel: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  requiredSkills: string[];
  niceToHaveSkills: string[];
  languagesRequired: string[];
}

export interface JdWriteResult {
  ok: boolean;
  message: string;
  tone?: "ok" | "note";
}
