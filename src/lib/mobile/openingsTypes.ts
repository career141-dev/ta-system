/**
 * The openings list and one opening's screen, for the native app.
 *
 * `GET  /api/mobile/v1/openings`                 → OpeningsPayload   (web `/openings`)
 * `GET  /api/mobile/v1/openings/{id}`            → OpeningPayload    (web `/openings/{id}` layout + Overview)
 * `POST /api/mobile/v1/openings/{id}/status`     ← SetStatusBody     → ActionResult
 * `POST /api/mobile/v1/openings/{id}/working-stage` ← SetWorkingStageBody → ActionResult
 * `POST /api/mobile/v1/openings/bin`             ← BinOpeningsBody   → BinResult
 *
 * Kept identical in ta-system `src/lib/mobile/openingsTypes.ts` and TA_APP
 * `src/types/openings.ts`: change both together.
 */

export type OpeningStatus = "open" | "on_hold" | "filled" | "closed";
export type WorkingStage = "100%" | "Follow-up" | "Add-on";
export type OpeningBucket = "mine" | "all" | "unassigned" | "hold" | "placed" | "closed";
export type LinkedInStatus = "connected" | "no_link" | "no_post";

export interface OpeningRow {
  id: string;
  clientId: string;
  clientName: string;
  clientIndustry: string | null;
  title: string;
  priorityTier: string;
  status: OpeningStatus;
  /** This person's own working stage; null when they may not set one. */
  workingStage: WorkingStage | null;
  targetNationalities: string[];
  locations: string[];
  /** Countries read from the locations, as the web's country filter reads them. */
  countries: string[];
  postCount: number;
  taIds: string[];
  taNames: string[];
  followUp: number;
  directorReview: number;
  cvsToday: number;
  daysOpen: number;
  targetDays: number;
  setsClosed: number;
  /** "your set 2 has 3", or "Nimali's set 2 has 3" on a desk-wide screen. */
  openSets: string[];
  assignedAt: number | null;
  jdWaiting: boolean;
  urgentAlerts: number;
  linkedin: LinkedInStatus;
  /** May move it to the Bin (opening.manage). */
  canBin: boolean;
  /** May change status (opening.manage). */
  canSetStatus: boolean;
  /** Which buckets it sits in, so the app filters without asking again. */
  buckets: OpeningBucket[];
}

export interface AvailableOpening {
  id: string;
  title: string;
  clientName: string;
  positionCode: string | null;
  leadName: string;
  assignedTaNames: string[];
  requestStatus: "pending" | "approved" | "rejected" | null;
  requestedAt: number | null;
}

export interface PendingAccessRequest {
  id: string;
  openingId: string;
  openingTitle: string;
  clientName: string;
  requesterName: string;
  requestReason: string | null;
  requestedAt: number;
}

export interface OpeningsPayload {
  apiVersion: 1;
  buckets: { key: OpeningBucket; label: string; count: number }[];
  rows: OpeningRow[];
  filters: {
    countries: string[];
    industries: string[];
    clients: { id: string; name: string }[];
    /** Only for desk-wide roles, as on the web. */
    tas: { id: string; name: string }[] | null;
  };
  /** A TA may ask for openings they are not on. */
  requestable: AvailableOpening[] | null;
  /** TA Lead and Admin approve those asks. */
  pendingRequests: PendingAccessRequest[] | null;
  canCreate: boolean;
}

export type OpeningSection =
  | "overview" | "pipeline" | "scoops" | "linkedin" | "jd" | "database" | "snippets" | "strategies" | "midday" | "eod"
  | "hh_overview" | "hh_research" | "hh_suggestions" | "hh_tables";

export interface OpeningShell {
  id: string;
  title: string;
  clientName: string;
  positionCode: string | null;
  status: OpeningStatus;
  workingStage: WorkingStage | null;
  team: { id: string; name: string; initials: string }[];
  canSetStatus: boolean;
  canBin: boolean;
  /** What this person may open here — the web rail, by their seat. */
  sections: OpeningSection[];
  /** Pipeline stages they may see, with counts for their own desk. */
  stages: { stage: string; label: string; count: number; closed: boolean }[];
  posts: { id: string; title: string; status: string; count: number }[];
  tables: { n: number; label: string; name: string; count: number }[];
  middayEmails: { id: string; number: number; status: string }[];
  workLocations: { id: string; name: string }[];
}

export type HealthBand = "good" | "slipping" | "stuck";

export type MatchingSnapshot =
  | { kind: "reading" | "running" | "slow"; since: number }
  | { kind: "error"; reason: string | null }
  | { kind: "finished"; at: number; added: number; note: string | null }
  | { kind: "idle"; lastAt: number | null };

export interface OpeningOverview {
  facts: string;
  inPipeline: number;
  cvsToday: number;
  daysOpen: number;
  targetDays: number;
  health: { score: number; band: HealthBand; headline: string; parts: { label: string; score: number; note: string }[] } | null;
  jdApproval: {
    jd: string;
    canApprove: boolean;
    approverLabel: string;
    hasBrief: boolean;
    briefSummary: string[];
  } | null;
  briefs: { id: string; author: string; isLead: boolean; notes: string; at: number }[];
  jobDetails: {
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    location: string | null;
    experienceMinYears: number | null;
    experienceMaxYears: number | null;
    seniorityLevel: string | null;
    educationLevel: string | null;
    clientIndustry: string | null;
    requiredSkills: string[];
    niceToHaveSkills: string[];
    languagesRequired: string[];
    recruitmentType: string;
    isConfidential: boolean;
  } | null;
  /** Null until the JD is approved, as on the web. */
  matching: { state: MatchingSnapshot; canRun: boolean } | null;
  suggested: { title: string; sub: string; href: string; action: string }[];
  pipeline: { stage: string; label: string; count: number }[];
  activity: { applicationId: string; candidateName: string; stageLabel: string; byName: string | null; at: number }[];
  about: {
    team: string[];
    lead: string | null;
    setsFinished: number;
    yourOpenSet: { setNumber: number; count: number } | null;
    reference: string | null;
    attention: number;
    attentionUrgent: boolean;
  };
  canEdit: boolean;
}

export type OpeningPayload =
  | { apiVersion: 1; access: "ok"; shell: OpeningShell; overview: OpeningOverview }
  /** Not on it, but a TA can ask to be. */
  | { apiVersion: 1; access: "requestable"; opening: AvailableOpening };

export interface SetStatusBody {
  status: OpeningStatus;
}

export interface SetWorkingStageBody {
  stage: WorkingStage;
}

export interface BinOpeningsBody {
  openingIds: string[];
}

export interface ActionResult {
  ok: true;
  message: string;
}

export interface BinResult {
  ok: true;
  message: string;
  binned: number;
  problems: string[];
}
